// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared helpers for threading per-run CLI instructions into analysis.
 *
 * `resolveCliInstructions` reads `--instructions` / `--instructions-file`.
 *
 * `buildInteractiveAnalysisConfig` / `prepareInteractiveAnalysisConfig` bridge the
 * CLI to the browser-side auto-analyze: interactive `--ai` / `--council` runs open
 * the web UI and trigger analysis via the `?analyze=true` URL, which has no slot
 * for custom instructions. To honor `--instructions` there too (instead of
 * silently dropping it), the CLI resolves the full review config + instructions
 * and threads a short id through the URL as `analysisConfigId`. The PR/local
 * browser code already resolves that id before starting analysis (see
 * `_fetchAutoAnalysisConfigFromUrl` in public/js/pr.js and the local auto-analyze
 * in public/js/local.js).
 *
 * The resolution is split so the same config object serves two storage targets:
 *   - `buildInteractiveAnalysisConfig` — PURE, returns the resolved config object
 *     (no storage). Reused by the delegation path, which POSTs it to a server
 *     running in ANOTHER process (the in-memory store below is per-process).
 *   - `prepareInteractiveAnalysisConfig` — the cold-start wrapper that stashes the
 *     built config in the in-memory bulk-analysis-config store (same process that
 *     then starts the server) and returns the id.
 *
 * Living in its own module keeps both CLI entry points — `handlePullRequest`
 * (src/main.js) and `handleLocalReview` (src/local-review.js) — able to import
 * it without a require cycle through main.js.
 */

const fs = require('fs');
const { resolveReviewConfig } = require('./review-config');
const { createBulkAnalysisConfig } = require('./routes/bulk-analysis-configs');

const MAX_INSTRUCTIONS_CHARS = 5000;

/**
 * Resolve per-run custom instructions ("requestInstructions") from CLI flags.
 *
 * Precedence: `--instructions <text>` is used directly; otherwise
 * `--instructions-file <path>` is read from disk. The result is trimmed and
 * capped at 5000 chars (parity with the web analyze routes). Returns `null`
 * when neither flag is supplied.
 *
 * @param {Object} flags - Parsed CLI flags
 * @returns {Promise<string|null>}
 * @throws {Error} On unreadable instructions file or when the text exceeds the cap.
 */
async function resolveCliInstructions(flags) {
  let text = null;

  if (typeof flags.instructions === 'string') {
    text = flags.instructions;
  } else if (typeof flags.instructionsFile === 'string') {
    try {
      text = await fs.promises.readFile(flags.instructionsFile, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read --instructions-file "${flags.instructionsFile}": ${err.message}`);
    }
  }

  if (text == null) return null;

  text = text.trim();
  if (text.length === 0) return null;

  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error(
      `Custom instructions exceed the ${MAX_INSTRUCTIONS_CHARS}-character limit (got ${text.length}).`
    );
  }

  return text;
}

/**
 * For an interactive `--ai` / `--council` run that ALSO carries
 * `--instructions[-file]`, resolve the full review config (single provider/model
 * or council) plus the instruction text into the analysis-config object the
 * browser-side analyze code consumes. PURE: it performs no storage, so it serves
 * both the in-process cold-start path (via `prepareInteractiveAnalysisConfig`)
 * and the cross-process delegation path (which POSTs the object to the running
 * server — see `storeAnalysisConfigRemote` in src/single-port.js).
 *
 * Returns `null` when no instructions were supplied, so callers keep their prior
 * URL shape (bare `?analyze=true` + optional `&council=`) unchanged.
 *
 * The returned config is shape-compatible with what the browser-side analyze code
 * consumes: a single pick becomes `{ provider, model, customInstructions }`; a
 * council becomes an inline snapshot `{ isCouncil, configType, councilConfig,
 * councilName, customInstructions }` (the snapshot forces the analysis route to
 * use the exact resolved council rather than re-fetching by id).
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance
 * @param {Object} params.config - Loaded global config
 * @param {Object} params.flags - Parsed CLI flags (council/provider/model/instructions)
 * @param {string} params.repository - owner/repo (for repo-default resolution)
 * @returns {Promise<Object|null>} The analysisConfig object, or null when no instructions.
 */
async function buildInteractiveAnalysisConfig({ db, config, flags, repository }) {
  const requestInstructions = await resolveCliInstructions(flags);
  if (!requestInstructions) return null;

  const reviewConfig = await resolveReviewConfig(
    db,
    repository,
    { council: flags.council, provider: flags.provider, model: flags.model },
    config
  );

  return reviewConfig.type === 'council'
    ? {
        isCouncil: true,
        configType: reviewConfig.configType,
        councilConfig: reviewConfig.councilConfig,
        councilName: reviewConfig.council.name || null,
        customInstructions: requestInstructions
      }
    : {
        provider: reviewConfig.provider,
        model: reviewConfig.model,
        customInstructions: requestInstructions
      };
}

/**
 * Thin in-process wrapper around `buildInteractiveAnalysisConfig`: resolve the
 * analysis config and, when present, stash it in the in-memory
 * bulk-analysis-config store, returning the id to thread through the browser URL
 * as `analysisConfigId`. Used by the cold-start handlers (`handlePullRequest`,
 * `handleLocalReview`) that go on to start the server in THIS process, so the
 * in-process store is the one the browser tab will read from.
 *
 * Returns `null` when no instructions were supplied (callers keep their prior URL
 * shape unchanged).
 *
 * @param {Object} params - See `buildInteractiveAnalysisConfig`.
 * @returns {Promise<string|null>} The analysisConfigId, or null when no instructions.
 */
async function prepareInteractiveAnalysisConfig({ db, config, flags, repository }) {
  const analysisConfig = await buildInteractiveAnalysisConfig({ db, config, flags, repository });
  if (!analysisConfig) return null;

  const { id } = createBulkAnalysisConfig(analysisConfig);
  return id;
}

module.exports = {
  resolveCliInstructions,
  buildInteractiveAnalysisConfig,
  prepareInteractiveAnalysisConfig
};
