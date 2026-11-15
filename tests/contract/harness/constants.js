// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Values shared by contract specs that the bridge will also need.
 */

/**
 * `unsafeCSS` that makes a file-level (lineNumber 0) annotation on a ROW-LESS
 * item (binary, mode-only, pure rename, empty file) measure correctly. The
 * text is production's: public/js/modules/pierre-styles.js explains the two
 * rules, and the CodeView bridge passes them in its `unsafeCSS`. The specs
 * that pin the vendor behaviour behind it (layout.spec.js, gate G11) import
 * it from here.
 */
const { ROWLESS_FIX } = require('../../../public/js/modules/pierre-styles.js');

/**
 * The rule as the plan's first draft had it. Kept so specs can show what it
 * gets wrong: nothing in split style, and header-only mounts of ordinary items.
 */
const ROWLESS_FIX_FIRST_DRAFT = '[data-code]:not(:has([data-line])) { padding-bottom: 0 !important; }';

/**
 * CSS the CodeView cut-over needs on top of pr.css, scoped by
 * `.diff-view.codeview-engine` as phase 5 will scope it. Recorded in the
 * ledger (section 6, correction 3); phase 5 moves it into pr.css under the
 * same scope. Gates G9 and G13 load it next to the unmodified stylesheet.
 */
const CANDIDATE_CSS = `
.main-layout .diff-view.codeview-engine { overflow: hidden; }
.diff-view.codeview-engine > #diff-container {
  flex: 1 1 0; min-height: 0; overflow-y: auto;
  /* The vendor lays items out from the top edge of the scroll root's content
     box and does not know about padding or a border above it: main's 16 px
     padding and 1 px border put every item 17 px below where the vendor
     thinks it is. The vertical space moves into layout.paddingTop/Bottom. */
  padding-top: 0; padding-bottom: 0; border-top-width: 0; border-bottom-width: 0;
}
.diff-view.codeview-engine diffs-container.d2h-file-wrapper[data-file-name] { margin-bottom: 0; }
.diff-view.codeview-engine .pr-file-header-slot { height: var(--pr-file-header-height); box-sizing: border-box; overflow: hidden; }
.diff-view.codeview-engine .pr-file-header-slot > .d2h-file-header { position: static; height: 100%; box-sizing: border-box; }
`;

module.exports = { ROWLESS_FIX, ROWLESS_FIX_FIRST_DRAFT, CANDIDATE_CSS };
