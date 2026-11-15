// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Fixture for the bridge-in-browser tests: the real @pierre/diffs bundle
 * (development build, height validator on), the real PierreCodeViewBridge
 * and the production modules it depends on, the deterministic workload, and
 * no pr.js. `openBridge(harness)` gives a page with `window.H` (the vendor
 * harness) and `window.BH` (bridge-page.js) ready.
 *
 * Everything the contract fixture enforces holds here too: any console.error
 * a spec did not declare fails the test, and the vendor's height validator
 * reports through console.error, so "validator 0" is every spec's default.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, VALIDATOR_PATTERN } = require('../harness/contract-test.js');
const { PATHS } = require('../harness/paths.js');

/**
 * The app's own rules for the gutter buttons, cut out of public/css/pr.css
 * (the block that starts at the "Dual gutter buttons" comment and ends at the
 * next section). The viewer positions the buttons inside the hovered line's
 * gutter cell; without these rules they have no box and sit under the line
 * number. Read from the stylesheet, not copied, so the tests see what ships.
 */
function appGutterCss() {
  const css = fs.readFileSync(path.join(PATHS.publicDir, 'css', 'pr.css'), 'utf8');
  const start = css.indexOf('/* Dual gutter buttons');
  const end = css.indexOf('/* ---', start);
  if (start === -1 || end === -1) throw new Error('pr.css: the gutter button rules were not found');
  const block = css.slice(start, end);
  if (!/\.pierre-gutter-buttons\s*\{[^}]*z-index/.test(block)) throw new Error('pr.css: .pierre-gutter-buttons lost its z-index');
  return block;
}

/** The production modules the bridge needs, in the order the app's pages load them. */
const BRIDGE_SCRIPTS = [
  '/app/js/modules/pierre-context.js',
  '/app/js/modules/pierre-styles.js',
  '/app/js/modules/pierre-annotations.js',
  '/app/js/modules/pierre-gutter.js',
  '/app/js/modules/pierre-codeview-bridge.js',
];

/**
 * @param {Object} harness - the contract fixture
 * @param {Object} [options]
 * @param {string[]} [options.before] - script URL paths loaded before the bridge's modules
 * @param {string[]} [options.after] - script URL paths loaded after them
 * @param {string[]} [options.styles] - stylesheet URL paths
 * @param {'dev'|'prod'} [options.bundle='dev']
 */
async function openBridge(harness, { before = [], after = [], styles = [], bundle = 'dev' } = {}) {
  const page = await harness.open({ bundle, styles, scripts: [...before, ...BRIDGE_SCRIPTS, ...after, '/bridge-page.js'] });
  // A page that loads pr.css itself already has them.
  if (!styles.includes('/app/css/pr.css')) await page.addStyleTag({ content: appGutterCss() });
  return page;
}

/**
 * A real click on one of a separator's expand controls, after scrolling it
 * into view. kind: 'up' | 'down' | 'both' | 'all'.
 * @returns {Promise<Object|null>} what BH.controlBox answered
 */
async function clickExpandControl(page, id, expandIndex, kind, { shift = false } = {}) {
  await page.evaluate(([file, index]) => window.BH.bringSeparator(file, index), [id, expandIndex]);
  const box = await page.evaluate(([file, index, k]) => window.BH.controlBox(file, index, k), [id, expandIndex, kind]);
  if (!box || box.missing || !box.visible) return box;
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await page.evaluate(() => window.H.settle(250));
  return box;
}

/**
 * Thirty changed files, the reader a little inside the fifteenth. Leaves
 * `window.T` with the entries, the line being read, how far that line has
 * moved since (`T.moved()`), and the entries with a context file put in at
 * an index (`T.withContext(index, extra)`).
 */
async function readingInTheMiddle(page, { options = {}, upgrade = false } = {}) {
  return page.evaluate(async ({ options, upgrade }) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    const names = H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 30);
    const entries = names.map((n) => BH.diffEntry(n));
    await BH.up({ entries, options });
    if (upgrade) {
      for (const n of names) { const { oldFile, newFile } = H.contentsOf(n); BH.bridge.upgradeFileContents(n, oldFile, newFile); }
    }
    BH.bridge.scrollToItem(names[14]);
    await H.settle(250);
    H.root.scrollTop += 137;
    await H.settle(400);
    const reading = H.firstVisibleItem();
    const firstRow = [...H.host(reading).shadowRoot.querySelectorAll('[data-content] > [data-line]')].find((row) => H.viewportTopOf(row) >= 40);
    const line = { n: Number(firstRow.getAttribute('data-line')), side: firstRow.getAttribute('data-line-type') === 'change-deletion' ? 'deletions' : 'additions', top: H.viewportTopOf(firstRow) };
    window.T = {
      names, entries, reading, line,
      moved: () => { const row = H.findRow(reading, line.n, line.side); return row ? H.viewportTopOf(row) - line.top : null; },
      withContext: (index, extra = {}) => { const next = entries.slice(); next.splice(index, 0, BH.contextEntry(extra.id || 'ctx/added-at-run-time.js', { contents: BH.numberedLines(400), ranges: [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }], ...extra })); return next; },
    };
    return { names, reading, readingIndex: names.indexOf(reading), line };
  }, { options, upgrade });
}

module.exports = { test, expect, VALIDATOR_PATTERN, BRIDGE_SCRIPTS, openBridge, clickExpandControl, readingInTheMiddle };
