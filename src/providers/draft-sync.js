// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Draft Sync Provider
 *
 * The shared half of "what pending review draft do I have on GitHub for this
 * pull request?" — used by three endpoints across both modes:
 *   - `GET  /api/pr/:owner/:repo/:number`                (src/routes/pr.js)
 *   - `GET  /api/pr/:owner/:repo/:number/github-drafts`  (src/routes/pr.js)
 *   - `POST /api/local/:reviewId/sync-drafts`            (src/routes/local.js)
 *
 * A draft ("pending") review started in the GitHub UI belongs to the PR, not
 * to the route that happens to be looking at it, so a local review whose
 * branch has an associated PR gets the same mirror in `github_reviews` that PR
 * mode has always had. See plans/bridge-local-and-pr-modes.md, Phase 4.
 *
 * Follows the `defaults + _deps` DI pattern from `src/protocol-handler.js`.
 * Never re-resolves config internally — callers pass a resolved credential
 * (a host binding or a bare token) down.
 *
 * WHAT THIS PROVIDER SYNCS, AND WHAT IT DOES NOT
 * ----------------------------------------------
 * It reconciles the `github_reviews` rows for one review against the single
 * pending draft GitHub reports for the authenticated user. It does NOT pull
 * the draft's individual comments into the diff: pending review comments are
 * not returned by the review-comments list API, so there is nothing to mirror
 * until the draft is submitted — at which point the ordinary external-comment
 * sync (src/routes/external-comments.js) picks them up.
 */

const { GitHubReviewRepository } = require('../database');
const { GitHubClient } = require('../github/client');
const logger = require('../utils/logger');

const defaults = {
  GitHubClient,
  GitHubReviewRepository,
  logger,
};

/**
 * In-flight reconciliations, keyed by database handle then review id.
 *
 * `syncPendingDraft` reads the mirror and writes it back across several
 * awaits, and nothing in SQLite serialises that read-modify-write for us. Two
 * overlapping calls for ONE review — two browser tabs, a reload landing on top
 * of a manual click, a direct API call — can therefore both miss the same
 * GitHub draft in `findPendingByReviewId` and both insert a row for it. The
 * partial unique indexes added in migration 57 are the durable boundary (a
 * loser now adopts the winner's row instead of doubling up); this map is the
 * cheap one, and it also keeps the second caller from spending a second GitHub
 * round-trip on a question already being asked.
 *
 * A joiner gets the STARTER's answer, which is the same semantic the browser's
 * `_draftSyncPromise` already has (public/js/local.js): both callers wanted
 * "what is on GitHub right now", and one round-trip answers both.
 *
 * @type {WeakMap<Object, Map<number, Promise<Object>>>}
 */
const inFlightSyncs = new WeakMap();

/**
 * Run `start()` unless an identical sync is already running for this
 * (db, reviewId) — in which case join it.
 *
 * @param {Object} db
 * @param {number} reviewId
 * @param {Function} start - Zero-arg async thunk
 * @returns {Promise<any>}
 */
function joinInFlightSync(db, reviewId, start) {
  // A non-object db (never in production; possible in a hand-rolled test) has
  // no WeakMap identity to key on — run unshared rather than throwing.
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) return start();

  let perDb = inFlightSyncs.get(db);
  if (!perDb) {
    perDb = new Map();
    inFlightSyncs.set(db, perDb);
  }
  const existing = perDb.get(reviewId);
  if (existing) return existing;

  const promise = start();
  // Registered before the first await point of any joiner.
  perDb.set(reviewId, promise);
  return promise.finally(() => {
    if (perDb.get(reviewId) === promise) perDb.delete(reviewId);
    if (perDb.size === 0) inFlightSyncs.delete(db);
  });
}

/**
 * Map a GitHub review state onto the `github_reviews.state` vocabulary.
 *
 * GitHub states: PENDING, APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED.
 * Ours: local, pending, submitted, dismissed.
 *
 * @param {string} githubState
 * @returns {string}
 */
function mapGitHubReviewState(githubState) {
  if (githubState === 'PENDING') return 'pending';
  if (githubState === 'DISMISSED') return 'dismissed';
  // APPROVED, CHANGES_REQUESTED, COMMENTED all mean it was submitted.
  return 'submitted';
}

/**
 * Resolve what actually became of the pending rows we hold that GitHub no
 * longer reports as the current draft, and write the answer back.
 *
 * Shared by the two paths that discover an orphan: a NEW draft appearing
 * (scenario 2) and GitHub reporting no draft at all (scenario 3). They had
 * drifted into one implementation and one gap; this is the single one.
 *
 * INDETERMINATE LOOKUPS DO NOT MUTATE. A thrown lookup — rate limit, outage,
 * a 5xx — establishes nothing about the review's state, so the row is left at
 * its last known value and reconciled on a later sync. Writing `dismissed`
 * there durably misclassified a review that was actually submitted (or still
 * pending), which is the user's review history being silently rewritten by a
 * network blip. `dismissed` is reserved for an authoritative answer: GitHub
 * returning the review with state DISMISSED, or returning nothing for an id it
 * would know.
 *
 * That split is only real because BOTH transports keep it. `getReviewById`
 * answers `null` for an authoritative not-found alone (a GraphQL NOT_FOUND or
 * missing node, a REST 404) and rejects on everything else, including the REST
 * case where it cannot build a lookup at all. They used to swallow every
 * failure into `null`, which made the catch below unreachable for exactly the
 * failures it exists for — see src/github/impl/{graphql,rest}/pending-review.js.
 *
 * The one non-authoritative `dismissed` that remains is a row we cannot look
 * up at all (no client, or neither identifier persisted) — there is no query
 * to make, and the row would otherwise stay pending forever.
 *
 * @param {GitHubReviewRepository} githubReviewRepo
 * @param {Array<Object>} oldRecords - Rows from `findPendingByReviewId`
 * @param {Object|null} githubClient
 * @param {Object|null} prContext - `{ owner, repo, prNumber }`, required for
 *   REST mode of `getReviewById`
 * @param {Object} deps - `{ logger }`
 * @returns {Promise<void>}
 */
async function reconcileOldPendingRecords(githubReviewRepo, oldRecords, githubClient, prContext, deps) {
  for (const oldRecord of oldRecords) {
    // On the GraphQL path the node id is the canonical identifier; on the REST
    // path the numeric id (`github_review_id`) is the only value we may have.
    // Run the lookup whenever we have either.
    const oldLookupId = oldRecord.github_node_id || oldRecord.github_review_id;
    if (!githubClient || !oldLookupId) {
      await githubReviewRepo.update(oldRecord.id, { state: 'dismissed' });
      continue;
    }

    let githubReviewData;
    try {
      // prContext carries the REST review id when available. The GraphQL path
      // ignores it. The github_review_id column holds the numeric REST id we
      // received when the draft was created.
      const reviewPrContext = prContext
        ? { ...prContext, reviewId: oldRecord.github_review_id }
        : null;
      githubReviewData = await githubClient.getReviewById(oldLookupId, reviewPrContext);
    } catch (error) {
      // Indeterminate — see the docblock. Leave the row alone.
      deps.logger.warn(
        `Error querying GitHub for old review ${oldLookupId}: ${error.message}; `
        + 'leaving its state unchanged'
      );
      continue;
    }

    let actualState;
    if (githubReviewData) {
      actualState = mapGitHubReviewState(githubReviewData.state);
      deps.logger.debug(`Old review ${oldLookupId} actual state from GitHub: ${githubReviewData.state} -> ${actualState}`);
    } else {
      // Authoritative not-found: the draft is gone.
      deps.logger.debug(`Old review ${oldLookupId} not found on GitHub, marking as dismissed`);
      actualState = 'dismissed';
    }

    const updateData = { state: actualState };
    if (actualState === 'submitted' && githubReviewData?.submittedAt) {
      updateData.submitted_at = githubReviewData.submittedAt;
    }
    await githubReviewRepo.update(oldRecord.id, updateData);
  }
}

/**
 * Sync pending draft review from GitHub with local database
 *
 * Handles two of the three scenarios; the third is the caller's, and
 * `syncPendingDraft` below implements it:
 * 1. Same draft updated - The draft we know about has been updated on GitHub. Update our record.
 * 2. NEW draft created outside pair-review - A new draft was created on GitHub (e.g., user
 *    started a review directly on GitHub). Create a new record and query GitHub for the actual
 *    state of old pending records (submitted or dismissed).
 * 3. No GitHub draft but we have pending records - this function is never
 *    called for that case (it takes the draft as an argument). The whole-flow
 *    entry point below runs the SAME reconciliation for it, on the success
 *    path only.
 *
 * @param {GitHubReviewRepository} githubReviewRepo - The GitHub review repository
 * @param {number} reviewId - The local review ID
 * @param {Object} githubPendingReview - The pending review data from GitHub GraphQL API
 * @param {GitHubClient} [githubClient] - Optional GitHub client for querying old review states
 * @param {Object} [prContext] - `{ owner, repo, prNumber }` — required for REST mode of `getReviewById`
 * @param {Object} [_deps] - Test overrides for `{ logger }`
 * @returns {Promise<Object>} The synced pending draft record with comments_count
 */
async function syncPendingDraftFromGitHub(githubReviewRepo, reviewId, githubPendingReview, githubClient = null, prContext = null, _deps = null) {
  const deps = { ...defaults, ..._deps };
  // Find all our pending records for this review
  const existingPendingRecords = await githubReviewRepo.findPendingByReviewId(reviewId);

  // Check if this GitHub draft matches any of our records. Match on
  // either the GraphQL node id OR the stringified numeric databaseId —
  // alt-host REST responses may not surface a node_id consistently, so
  // a numeric-id-only record is the only identifier we have to anchor
  // a draft against an existing local record.
  const githubDbIdStr = (githubPendingReview.databaseId !== undefined && githubPendingReview.databaseId !== null)
    ? String(githubPendingReview.databaseId)
    : null;
  const matchingRecord = existingPendingRecords.find(r =>
    (r.github_node_id && r.github_node_id === githubPendingReview.id) ||
    (githubDbIdStr !== null && r.github_review_id === githubDbIdStr)
  );

  // An ABSENT databaseId is SQL NULL, never the string "null". Stringifying it
  // blind minted a shared literal identity: two different GitHub reviews whose
  // databaseId did not come back both carried `github_review_id = 'null'`, so
  // `findByGitHubReviewId` matched the wrong row and migration 57's unique
  // index treated them as one review. `githubDbIdStr` is already that
  // normalisation; the writes below use it, and omit the column entirely when
  // it is null so a row that DOES carry a numeric id is never blanked by a
  // response that happened not to include one.
  const numericIdFields = githubDbIdStr === null ? {} : { github_review_id: githubDbIdStr };

  let pendingDraft;
  if (matchingRecord) {
    // Same draft - update it with latest data from GitHub
    await githubReviewRepo.update(matchingRecord.id, {
      ...numericIdFields,
      github_url: githubPendingReview.url,
      body: githubPendingReview.body,
      state: 'pending'
    });
    pendingDraft = await githubReviewRepo.getById(matchingRecord.id);
  } else {
    // New draft from GitHub - resolve what became of the drafts we still hold
    // as pending, then record this one.
    await reconcileOldPendingRecords(
      githubReviewRepo, existingPendingRecords, githubClient, prContext, deps
    );

    // `upsertFromGitHub`, not `create`: the lookup above and this write span
    // awaits, so a concurrent sync may already have inserted the row that
    // migration 57's unique indexes now protect. The repository resolves that
    // conflict into an update instead of a 500 — and it is the same writer the
    // submit path uses, so a draft that is later submitted updates this row
    // rather than doubling up.
    pendingDraft = await githubReviewRepo.upsertFromGitHub(reviewId, {
      ...numericIdFields,
      github_node_id: githubPendingReview.id,
      github_url: githubPendingReview.url,
      body: githubPendingReview.body,
      state: 'pending'
    });
  }

  pendingDraft.comments_count = githubPendingReview.comments?.totalCount || 0;
  return pendingDraft;
}

/**
 * Fetch the authenticated user's pending draft for one PR and reconcile it
 * with the `github_reviews` mirror, then report every mirror row back.
 *
 * The whole-flow entry point, so the two endpoints that need `pendingDraft`
 * AND `allGithubReviews` (PR mode's `github-drafts`, local mode's
 * `sync-drafts`) cannot drift apart. `GET /api/pr/:owner/:repo/:number` calls
 * `syncPendingDraftFromGitHub` directly instead — NOT because it already
 * holds a client (the one it builds is used for this block alone), but
 * because its error contract is wider: that block swallows client
 * CONSTRUCTION too, so an alt-host repo with no token renders a degraded page
 * instead of failing. Adopting this wrapper there wholesale would turn that
 * into a 500.
 *
 * ERROR CONTRACT — deliberately asymmetric:
 *   - Building the client throws (an unusable credential is a caller bug —
 *     every caller resolves one through `resolveFetchCredential` first).
 *   - The GitHub round-trip does NOT. Draft state is supplementary: a rate
 *     limit or an outage must not take down the page that asked. The failure
 *     is logged, `syncSucceeded: false` says so explicitly, and the LOCAL
 *     mirror is returned unchanged.
 *   - Database work DOES throw. Reconciliation and the mirror read run
 *     OUTSIDE the GitHub catch, so a persistence failure reaches the route's
 *     error handler instead of being reported to the user as "GitHub is
 *     unreachable" with a 200.
 *
 * `syncSucceeded` exists because `pendingDraft: null` answers two different
 * questions — "GitHub says you have no draft" and "we could not ask". Only
 * the first may clear a rendered indicator; see `_syncGitHubDrafts` in
 * public/js/local.js.
 *
 * SCENARIO 3 (no draft on GitHub, pending rows here) is reconciled on the
 * SUCCESS path only. Doing it on the swallowed-error path is how a rate limit
 * would mass-dismiss live drafts.
 *
 * @param {Object} params
 * @param {Object} params.db - Database handle
 * @param {number} params.reviewId - `reviews.id` the mirror rows belong to
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {Object|string} params.credential - Resolved host binding or bare
 *   token; see `resolveFetchCredential` in src/providers/pr-context.js
 * @param {Object} [params._deps] - Test overrides for
 *   `{ GitHubClient, GitHubReviewRepository, logger }`
 * @returns {Promise<{pendingDraft: Object|null, allGithubReviews: Array<Object>, syncSucceeded: boolean}>}
 */
async function syncPendingDraft({ db, reviewId, owner, repo, prNumber, credential, _deps } = {}) {
  const deps = { ...defaults, ..._deps };

  // Outside the flight on purpose — see the ERROR CONTRACT above. Every
  // caller validates its own credential rather than inheriting a joiner's.
  const githubClient = new deps.GitHubClient(credential);

  return joinInFlightSync(db, reviewId, () => runPendingDraftSync({
    db, reviewId, owner, repo, prNumber, githubClient, deps
  }));
}

/** The body of one `syncPendingDraft`, after the in-flight join. */
async function runPendingDraftSync({ db, reviewId, owner, repo, prNumber, githubClient, deps }) {
  const githubReviewRepo = new deps.GitHubReviewRepository(db);

  let githubPendingReview = null;
  let syncSucceeded = true;
  try {
    githubPendingReview = await githubClient.getPendingReviewForUser(owner, repo, prNumber);
  } catch (githubError) {
    // Log the error but don't fail the request - return local data only
    syncSucceeded = false;
    deps.logger.warn('Failed to fetch pending review from GitHub:', githubError.message);
  }

  let pendingDraft = null;
  if (syncSucceeded) {
    const prContext = { owner, repo, prNumber };
    if (githubPendingReview) {
      pendingDraft = await syncPendingDraftFromGitHub(
        githubReviewRepo, reviewId, githubPendingReview, githubClient, prContext, deps
      );
    } else {
      // Scenario 3: GitHub authoritatively reports no draft, so every row we
      // still hold as pending was submitted or discarded elsewhere. Left
      // unreconciled they ship in `allGithubReviews` as live drafts forever.
      const orphans = await githubReviewRepo.findPendingByReviewId(reviewId);
      await reconcileOldPendingRecords(githubReviewRepo, orphans, githubClient, prContext, deps);
    }
  }

  const allGithubReviews = await githubReviewRepo.findByReviewId(reviewId);
  return { pendingDraft, allGithubReviews, syncSucceeded };
}

/**
 * The wire shape of a pending draft. One definition so PR mode's
 * `github-drafts` response, PR mode's page-load `GET /api/pr/...` response and
 * local mode's `sync-drafts` response stay byte-identical — the frontend's
 * `updatePendingDraftIndicator` is shared between them and reads
 * `github_url` / `comments_count`.
 *
 * @param {Object|null} pendingDraft - Row from `syncPendingDraftFromGitHub`
 * @returns {Object|null}
 */
function serializePendingDraft(pendingDraft) {
  if (!pendingDraft) return null;
  return {
    id: pendingDraft.id,
    github_review_id: pendingDraft.github_review_id,
    github_node_id: pendingDraft.github_node_id,
    github_url: pendingDraft.github_url,
    comments_count: pendingDraft.comments_count || 0,
    created_at: pendingDraft.created_at
  };
}

module.exports = {
  syncPendingDraftFromGitHub,
  syncPendingDraft,
  serializePendingDraft,
  _internals: { mapGitHubReviewState, reconcileOldPendingRecords },
};
