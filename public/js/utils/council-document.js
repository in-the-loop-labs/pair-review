// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Council document format — the single canonical serialization of a council.
 *
 * A council document carries everything needed to recreate a council: the
 * format version, its name, its type ('council' = voice-centric, 'advanced' =
 * level-centric), an optional description, and the `config` object exactly as
 * stored in the `councils.config` column:
 *
 *   {
 *     "pair_review_council": 1,
 *     "name": "Dream Team",
 *     "type": "council",
 *     "description": "Optional free text",
 *     "config": { "voices": [...], "levels": {...}, "consolidation": {...} }
 *   }
 *
 * The old "export" copied the bare config JSON to the clipboard: no name, no
 * type, no version, so it could never round-trip. Everything that reads or
 * writes a council outside the database — the export buttons, councils on disk,
 * the CLI — goes through this module so the format is defined in exactly one
 * place.
 *
 * Loaded in the browser as `window.CouncilDocument` and required directly by
 * server code (CommonJS), so it must stay pure logic: NO DOM access at load
 * time. `exportCouncilToFile` is the one browser-only entry point and guards
 * itself.
 */

const COUNCIL_DOCUMENT_VERSION = 1;
const COUNCIL_DOCUMENT_TYPES = ['council', 'advanced'];

/**
 * Build a council document object from its parts.
 *
 * @param {Object} params
 * @param {string} params.name - Council name (required, non-empty after trim)
 * @param {string} params.type - 'council' or 'advanced'
 * @param {Object} params.config - The council config object
 * @param {string} [params.description] - Optional free text; omitted when empty
 * @returns {Object} The council document
 * @throws {Error} When name, type, or config is missing or invalid
 */
function buildCouncilDocument({ name, type, config, description } = {}) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) {
    throw new Error('Council name is required');
  }
  if (!COUNCIL_DOCUMENT_TYPES.includes(type)) {
    throw new Error(`Council type must be "council" or "advanced" (got ${JSON.stringify(type)})`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Council config must be an object');
  }

  const doc = {
    pair_review_council: COUNCIL_DOCUMENT_VERSION,
    name: trimmedName,
    type
  };

  const trimmedDescription = typeof description === 'string' ? description.trim() : '';
  if (trimmedDescription) {
    doc.description = trimmedDescription;
  }

  doc.config = config;
  return doc;
}

/**
 * Parse and validate a council document.
 *
 * @param {string|Object} input - JSON text or an already-parsed object
 * @param {Object} [options]
 * @param {Function} [options.validateConfig] - `(config, type) => string|null`;
 *   a returned string is treated as a validation error and thrown
 * @returns {{name: string, type: string, config: Object, description: string|undefined}}
 * @throws {Error} With a human-readable message on any malformed input
 */
function parseCouncilDocument(input, { validateConfig } = {}) {
  let raw = input;

  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Council document is not valid JSON: ${error.message}`);
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Council document must be a JSON object');
  }

  if (raw.pair_review_council === undefined) {
    throw new Error('Not a council document (missing "pair_review_council" version field)');
  }
  if (raw.pair_review_council !== COUNCIL_DOCUMENT_VERSION) {
    throw new Error(
      `Unsupported council document version: ${JSON.stringify(raw.pair_review_council)} ` +
      `(expected ${COUNCIL_DOCUMENT_VERSION})`
    );
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    throw new Error('Council document is missing a "name"');
  }

  const type = raw.type;
  if (!COUNCIL_DOCUMENT_TYPES.includes(type)) {
    throw new Error(`Council document "type" must be "council" or "advanced" (got ${JSON.stringify(type)})`);
  }

  const config = raw.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Council document "config" must be an object');
  }

  if (typeof validateConfig === 'function') {
    const configError = validateConfig(config, type);
    if (typeof configError === 'string' && configError) {
      throw new Error(configError);
    }
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  return { name, type, config, description: description || undefined };
}

/**
 * Slugify a council name: lowercase, collapse every run of non-alphanumeric
 * characters to a single dash, strip leading/trailing dashes. No fallback — an
 * unsluggable name yields the empty string.
 *
 * INVARIANT: this is the single implementation of the council slug, shared with
 * `normalizeForMatch` in `src/councils/resolve-council.js` (which delegates
 * here). The exported filename stem produced by `councilFilenameStem` must stay
 * a resolvable `--council` handle: `dream-team.council.json` IS
 * `--council dream-team`. Do not fork this algorithm.
 *
 * @param {string} name
 * @returns {string} Lowercase slug, possibly empty
 */
function slugifyCouncilName(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Slugify a council name into a filename stem.
 *
 * The 'council' fallback is filename-only: handle matching must NOT inherit it,
 * or an unnamed council would answer to the handle "council".
 *
 * @param {string} name
 * @returns {string} Lowercase slug, or 'council' when nothing usable remains
 */
function councilFilenameStem(name) {
  return slugifyCouncilName(name) || 'council';
}

/**
 * Copy text to the clipboard, reporting the outcome without ever rejecting.
 *
 * @param {string} text
 * @returns {Promise<boolean>} true when the write succeeded; false when it was
 *   denied, threw synchronously, or the clipboard API is unavailable
 * @private
 */
function _copyTextToClipboard(text) {
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      return Promise.resolve(false);
    }
    return Promise.resolve(clipboard.writeText(text)).then(() => true, () => false);
  } catch (_error) {
    return Promise.resolve(false);
  }
}

/**
 * Download a council document as `<stem>.council.json` and, best-effort, copy
 * it to the clipboard. Browser-only.
 *
 * The download is the deliverable; the clipboard copy is a convenience that
 * must never fail it. The outcome is still reported so callers can tell the
 * user the truth instead of promising a copy that never happened: `copied`
 * resolves `true` on a successful write and `false` on denial, on a synchronous
 * throw, or when the clipboard API is absent. It NEVER rejects, so ignoring it
 * cannot produce an unhandled rejection.
 *
 * @param {Object} params - `{ name, type, config, description }`
 * @returns {{doc: Object, copied: Promise<boolean>}} The exported document and
 *   the pending clipboard outcome
 * @throws {Error} When called outside a browser, or when the document is invalid
 */
function exportCouncilToFile({ name, type, config, description } = {}) {
  if (typeof document === 'undefined') {
    throw new Error('exportCouncilToFile is browser-only');
  }

  const doc = buildCouncilDocument({ name, type, config, description });
  const json = JSON.stringify(doc, null, 2);

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${councilFilenameStem(doc.name)}.council.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next macrotask: revoking synchronously after click() can
  // cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);

  return { doc, copied: _copyTextToClipboard(json) };
}

// The browser (window.CouncilDocument) and CommonJS surfaces must stay
// identical — the tabs only ever see the former, server code only the latter.
// tests/unit/council-document-export.test.js pins them against each other.
const councilDocumentApi = {
  COUNCIL_DOCUMENT_VERSION,
  COUNCIL_DOCUMENT_TYPES,
  buildCouncilDocument,
  parseCouncilDocument,
  slugifyCouncilName,
  councilFilenameStem,
  exportCouncilToFile
};

if (typeof window !== 'undefined') {
  window.CouncilDocument = { ...councilDocumentApi };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ...councilDocumentApi };
}
