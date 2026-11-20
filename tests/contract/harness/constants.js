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
 *
 * The rules key on a class of the file's host, which production's
 * `PierreStyles.markRowless` sets after every draw. A spec that runs the
 * viewer without the bridge loads the module into the page
 * (`harness.open({ scripts: ROWLESS_SCRIPTS })`) and installs the same call
 * as its post-render hook (`MARK_ROWLESS`, evaluated in the page).
 */
const { ROWLESS_FIX } = require('../../../public/js/modules/pierre-styles.js');
const ROWLESS_SCRIPTS = ['/app/js/modules/pierre-styles.js'];
const MARK_ROWLESS = 'window.H.hooks.onPostRender = (node, instance, phase) => { window.PierreStyles.markRowless(node, phase !== "unmount"); };';

/**
 * The rule as the plan's first draft had it. Kept so specs can show what it
 * gets wrong: nothing in split style, and header-only mounts of ordinary items.
 */
const ROWLESS_FIX_FIRST_DRAFT = '[data-code]:not(:has([data-line])) { padding-bottom: 0 !important; }';

/**
 * The stylesheets the application's two diff pages load, in the order they
 * load them, as harness URLs. Read from the pages themselves: a gate that
 * says "under the app's real CSS" has to load every one of them (styles.css,
 * loaded after pr.css, changes the file header's padding and border with
 * `!important`; a gate that loaded pr.css alone measured a 45 px header where
 * the application's is 53 px).
 * @returns {string[]}
 */
function appStylesheets() {
  const fs = require('node:fs');
  const path = require('node:path');
  const publicDir = path.resolve(__dirname, '../../../public');
  const local = (page) => [...fs.readFileSync(path.join(publicDir, page), 'utf8').matchAll(/<link rel="stylesheet" href="(\/css\/[^"]+)"/g)]
    .map((match) => `/app${match[1]}`);
  const pr = local('pr.html');
  if (pr.length === 0) throw new Error('pr.html lists no stylesheet of its own');
  if (JSON.stringify(pr) !== JSON.stringify(local('local.html'))) {
    throw new Error('pr.html and local.html load different stylesheets: the gates must run for each');
  }
  return pr;
}

module.exports = { ROWLESS_FIX, ROWLESS_SCRIPTS, MARK_ROWLESS, ROWLESS_FIX_FIRST_DRAFT, appStylesheets };
