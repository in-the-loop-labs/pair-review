// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * API-boundary validation for the optional `rendered_anchor` a comment can
 * carry — the pair-review-LOCAL descriptor of the nested Rendered Markdown
 * element (list item, nested list item, table row, header cell, data cell)
 * the reviewer selected.
 *
 * WHY IT EXISTS AT ALL: a Markdown table's cells all share one source line
 * and parent/nested list item ranges overlap, so `line_start`/`line_end`
 * cannot tell those targets apart after a reload. The descriptor closes that
 * gap for OUR display only. It is never used to build GitHub coordinates —
 * `file` + `side` + `line_start`/`line_end` + `diff_position` remain the
 * whole submission contract (see src/routes/pr.js).
 *
 * WHY IT VALIDATES SO STRICTLY: this value is accepted over HTTP, stored,
 * and later formatted back into the UI. Anything that is not exactly a
 * known-version, known-kind, in-range descriptor is rejected outright
 * (fail closed) rather than stored "just in case" — an unusable anchor must
 * degrade to the honest line-based fallback, and an oversized or
 * unrecognised one must never reach the database.
 *
 * The shape rules themselves live in
 * public/js/modules/rendered-markdown.js and are shared verbatim with the
 * browser, so the producer and this validator cannot drift apart. That
 * module is dependency-free and Node-safe (it only touches `window` when
 * one exists) and ships with the package.
 */

const {
  normalizeRenderedAnchor,
  RENDERED_ANCHOR_MAX_JSON_CHARS
} = require('../../public/js/modules/rendered-markdown.js');

/**
 * Validate a request-supplied rendered anchor and return the JSON string to
 * persist.
 *
 * @param {*} value - `req.body.rendered_anchor` (absent/null is valid and
 *   means "no nested target", which is the case for every comment made
 *   outside the Rendered Markdown view)
 * @param {object} [opts]
 * @param {number} [opts.lineStart] - the comment's own start line
 * @param {number} [opts.lineEnd] - the comment's own end line
 * @returns {{ok: true, value: (string|null)} | {ok: false, error: string}}
 */
function validateRenderedAnchor(value, opts = {}) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: null };
  }

  // Reject before parsing: an oversized payload should never be walked.
  if (typeof value === 'string' && value.length > RENDERED_ANCHOR_MAX_JSON_CHARS) {
    return { ok: false, error: 'rendered_anchor is too large' };
  }

  const anchor = normalizeRenderedAnchor(value);
  if (!anchor) {
    return {
      ok: false,
      error: 'rendered_anchor must be a supported {v, kind, startLine, endLine, ordinal} descriptor'
    };
  }

  // The descriptor describes part of the comment's own range. A descriptor
  // pointing somewhere else would be a nonsense record that could only
  // mislead the reviewer later, so it is refused rather than stored.
  const lineStart = Number(opts.lineStart);
  const lineEnd = Number(opts.lineEnd == null ? opts.lineStart : opts.lineEnd);
  if (Number.isInteger(lineStart) && Number.isInteger(lineEnd)) {
    const lo = Math.min(lineStart, lineEnd);
    const hi = Math.max(lineStart, lineEnd);
    if (anchor.startLine < lo || anchor.endLine > hi) {
      return { ok: false, error: 'rendered_anchor range must fall within the comment line range' };
    }
  }

  const serialized = JSON.stringify(anchor);
  if (serialized.length > RENDERED_ANCHOR_MAX_JSON_CHARS) {
    return { ok: false, error: 'rendered_anchor is too large' };
  }
  return { ok: true, value: serialized };
}

module.exports = { validateRenderedAnchor };
