// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * File-based councils: a read-only overlay loaded from council document files
 * on disk (`~/.pair-review/councils/*.json`).
 *
 * Each file is a council document (see public/js/utils/council-document.js) and
 * the FILE is the single owner of that council — the app never writes these
 * rows back. They surface everywhere DB councils do (selectors, `--council`
 * handles, repo/global defaults, `--list-councils`) via `CouncilStore`
 * (./council-store.js), carrying `source: 'file'` and `readOnly: true` so
 * write paths can refuse them.
 *
 * Loading is fail-soft by design: a missing directory, an unreadable file, or
 * an invalid document must NEVER crash startup — bad files are warned about and
 * skipped. Note the deliberate contrast with `CouncilRepository._parseRow`,
 * which silently coerces corrupt config JSON to `{}`: a file council with a
 * bad config is dropped loudly, never served empty.
 *
 * The returned `config` is the ORIGINAL parsed config from the document, not
 * the normalized form — every downstream consumer already normalizes before
 * validating/running (the same reason routes store what the client sent).
 */

const path = require('path');
// Not destructured: the E2E test server monkeypatches `configModule.getConfigDir`
// after modules load, so the lookup must happen at call time. Named
// `configModule` so the council-document `config` locals below can't shadow it.
const configModule = require('../config');
const logger = require('../utils/logger');
const { parseCouncilDocument } = require('../../public/js/utils/council-document');
const { normalizeAndValidateCouncilConfig } = require('./council-validation');

/**
 * Injectable dependencies (see `src/protocol-handler.js` for the pattern).
 * `fs` is the promises API.
 */
const defaults = {
  fs: require('fs').promises,
  logger,
  // The provider registry lookup council validation needs (see the
  // PROVIDER-REGISTRY INVARIANT in ./council-validation.js). Required from
  // `../ai/provider` — the registry only, so no Express comes along — and
  // injected rather than left ambient so tests (and any caller that has not
  // loaded `src/ai`) can supply their own.
  getProviderClass: require('../ai/provider').getProviderClass
};

/**
 * The default councils directory: `<config dir>/councils`.
 * @returns {string}
 */
function defaultCouncilsDir() {
  return path.join(configModule.getConfigDir(), 'councils');
}

/**
 * Derive a file council's stem (its identity) from its filename:
 * `dream-team.council.json` → `dream-team`, `dream-team.json` → `dream-team`.
 * @param {string} filename
 * @returns {string}
 */
function councilFileStem(filename) {
  if (filename.endsWith('.council.json')) {
    return filename.slice(0, -'.council.json'.length);
  }
  return filename.slice(0, -'.json'.length);
}

/**
 * Load every valid council document from the given directories.
 *
 * @param {Object} [options]
 * @param {string[]} [options.dirs] - Directories to scan (default: the global
 *   councils dir). Order matters for future multi-dir support.
 * @param {Object} [options._deps] - Dependency overrides (see `defaults`)
 * @returns {Promise<Array<Object>>} Rows shaped like `CouncilRepository` rows
 *   plus `{ source: 'file', readOnly: true, filePath, description }`; ids are
 *   `file:<stem>`.
 */
async function loadFileCouncils({ dirs = [defaultCouncilsDir()], _deps } = {}) {
  const deps = { ...defaults, ..._deps };
  const councils = [];
  const seenStems = new Set();

  for (const dir of dirs) {
    let entries;
    try {
      entries = await deps.fs.readdir(dir);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        deps.logger.warn(`Failed to read councils directory ${dir}: ${error.message}`);
      }
      continue;
    }

    const jsonFiles = entries.filter(name => name.endsWith('.json')).sort();

    for (const filename of jsonFiles) {
      const filePath = path.join(dir, filename);
      try {
        const text = await deps.fs.readFile(filePath, 'utf-8');
        // Validate what the runtime will actually run: normalize first, then
        // validate — the same two-step sequence every save/run path performs.
        const validateConfig = (config, type) =>
          normalizeAndValidateCouncilConfig(config, type, {
            getProviderClass: deps.getProviderClass
          }).error;
        const { name, type, config, description } = parseCouncilDocument(text, { validateConfig });

        const stem = councilFileStem(filename);
        // The stem IS the council's identity and lands in URLs and API paths,
        // so it must round-trip encodeURIComponent unchanged. This also kills
        // the degenerate bare `file:` id a file named just `.json` would mint.
        if (!stem || stem !== encodeURIComponent(stem)) {
          deps.logger.warn(
            `Skipping council file ${filePath}: filename must be URL-safe and non-empty`
          );
          continue;
        }
        if (seenStems.has(stem)) {
          // `foo.council.json` and `foo.json` share the stem `foo`; ids must be
          // unique, so the alphabetically-first file wins.
          deps.logger.warn(
            `Skipping council file ${filePath}: another file already defines "file:${stem}"`
          );
          continue;
        }
        seenStems.add(stem);

        councils.push({
          id: `file:${stem}`,
          name,
          type,
          config,
          description: description || null,
          last_used_at: null,
          created_at: null,
          updated_at: null,
          source: 'file',
          readOnly: true,
          filePath
        });
      } catch (error) {
        deps.logger.warn(`Skipping invalid council file ${filePath}: ${error.message}`);
      }
    }
  }

  return councils;
}

module.exports = {
  defaultCouncilsDir,
  councilFileStem,
  loadFileCouncils
};
