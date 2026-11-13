// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Values shared by contract specs that the bridge will also need.
 */

/**
 * `unsafeCSS` that makes a file-level (lineNumber 0) annotation on a ROW-LESS
 * item (binary, mode-only, pure rename, empty file) measure correctly.
 *
 * The vendor keeps 8 px of bottom padding below the code area and only counts
 * it when the item has rows. With an annotation but no rows the DOM is 8 px
 * taller than the vendor's layout (contract: layout.spec.js, F10).
 *
 * Two things make the selector more than "code without lines":
 *
 *  - The padding is on a different element per diff style: `code[data-code]`
 *    in unified (pre is a block), `pre[data-diff]` in split (pre is the grid
 *    and code is display: contents). Hence two rules.
 *  - An ordinary item is sometimes mounted with NO rows in its rendered window
 *    (a header-only mount at the edge of the viewport). There the vendor DOES
 *    count the 8 px, so the rule must not match. Such a mount renders no
 *    annotation wrapper either, while a row-less item with a file-level
 *    annotation always has one. Hence `:has([data-line-annotation])`.
 */
const ROWLESS_FIX = [
  '[data-code]:has([data-line-annotation]):not(:has([data-line])) { padding-bottom: 0 !important; }',
  'pre[data-diff]:has([data-line-annotation]):not(:has([data-line])) { padding-bottom: 0 !important; }',
].join('\n');

/**
 * The rule as the plan's first draft had it. Kept so specs can show what it
 * gets wrong: nothing in split style, and header-only mounts of ordinary items.
 */
const ROWLESS_FIX_FIRST_DRAFT = '[data-code]:not(:has([data-line])) { padding-bottom: 0 !important; }';

module.exports = { ROWLESS_FIX, ROWLESS_FIX_FIRST_DRAFT };
