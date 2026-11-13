// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Gate G9 (plans/codeview-virtualized-diff.md): does the vendor's layout stay
 * exact under the APP's real CSS and the APP's real header?
 *
 * The other contract specs use a 40 px stand-in header and stand-in cards.
 * This one loads the app's real stylesheet and real modules into the harness:
 *
 *  - public/css/pr.css, unmodified
 *  - the file header built by PRManager.prototype.renderFileDiff itself
 *    (DiffRenderer.createFileHeader plus the comment, chat and summary-toggle
 *    buttons), in every variant: plain, renamed, generated, viewed, with the
 *    comment indicator filled, with the summary toggle enabled
 *  - the file-comment zone element from FileCommentManager
 *  - PierreBridge.ANNOTATION_CSS as unsafeCSS, and comment cards, a comment
 *    form and a suggestion card built by main's PierreBridge renderers
 *
 * and lays them out the way the plan's section 3.2 / 3.6 specifies, with the
 * CSS the cut-over will need (CANDIDATE_CSS below, scoped by
 * `.diff-view.codeview-engine` exactly as phase 5 will scope it):
 *
 *  - #diff-container is the scroll root
 *  - the header slot root has a fixed height, a token whose value is main's
 *    measured header height, and itemMetrics.diffHeaderHeight is that value
 *  - the vendor host carries `d2h-file-wrapper` and `data-file-name` but NOT
 *    the 24 px bottom margin; the space between files is `layout.gap: 24`
 *  - the scroll root has no vertical padding or border (main's 16 px + 1 px
 *    move into `layout.paddingTop` / `paddingBottom`)
 *  - itemMetrics.lineHeight is the app's real row height, measured (pr.css
 *    makes rows 17.39 px, not the vendor's default 20)
 *
 * The verdict is the development bundle's height validator plus the harness
 * audit across a walk of the whole list, in light and dark, unified and
 * split. Any mismatch is a console.error and fails the test.
 */

import { test, expect, VALIDATOR_PATTERN } from '../harness/contract-test.js';
import { ROWLESS_FIX } from '../harness/constants.js';

const APP_STYLES = ['/app/css/pr.css'];
const APP_SCRIPTS = [
  '/app/js/utils/smart-truncate.js',
  '/app/js/modules/diff-renderer.js',
  '/app/js/modules/pierre-bridge.js',
  '/app/js/modules/file-comment-manager.js',
  '/app/js/pr.js',
];

/**
 * CSS the CodeView cut-over needs on top of pr.css. Recorded in the ledger;
 * phase 5 moves it into pr.css under the same scope.
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

/**
 * Build the app-shaped page: real layout elements, real header factory, real
 * cards. Runs in the page. Leaves `window.G9` with everything the walk needs.
 */
async function setUpAppShapedViewer(page, { theme, diffStyle, lineHeightMode = 'measured' }) {
  return page.evaluate(async ({ theme, diffStyle, lineHeightMode, candidateCss, rowlessFix }) => {
    const H = window.H;
    const { roles } = H.workload;
    document.documentElement.setAttribute('data-theme', theme);

    // ---- layout: .main-layout > main.diff-view > #diff-container (pr.html) ----
    const layout = document.createElement('div');
    layout.className = 'main-layout';
    layout.style.cssText = 'height: 100vh; width: 100vw;';
    const view = document.createElement('main');
    view.className = 'diff-view';
    const container = document.createElement('div');
    container.id = 'diff-container';
    container.className = 'diff-container';
    view.appendChild(container);
    layout.appendChild(view);
    document.body.replaceChildren(layout);

    // ---- the real header factory, on a PRManager that was never constructed ----
    // pr.js declares `class PRManager` at the top level of a classic script:
    // a global lexical binding, not a property of window.
    const manager = Object.create(PRManager.prototype);
    manager.generatedFiles = new Map();
    manager.viewedFiles = new Set();
    manager.collapsedFiles = new Set();
    manager.summariesHiddenFiles = new Set();
    manager._summaryHashesByFile = new Map();
    manager._summariesEnabled = true;
    manager._lazyFileBodies = new Map();
    manager._renderGen = 1;
    manager.fileCommentManager = new window.FileCommentManager(manager);
    // The only decision renderFileDiff asks for; the body it then registers is not used here.
    manager._getPierreRenderDecision = () => ({ usePierre: true, forcePlainText: false, deferDiff: false });

    const names = H.workload.modifiedPaths.slice(0, 14);
    const variantOf = {
      [names[1]]: 'renamed',
      [names[2]]: 'generated',
      [names[3]]: 'viewed',
      [names[4]]: 'comment-indicator',
      [names[5]]: 'summary-toggle',
      [names[6]]: 'long-path',
    };
    const longPath = `${'deeply/nested/'.repeat(14)}some-very-long-file-name-that-cannot-fit.js`;
    manager.generatedFiles.set(names[2], { insertions: 120, deletions: 4 });
    manager.viewedFiles.add(names[3]);
    manager._summaryHashesByFile.set(names[5], new Set(['hash-1']));

    const parts = new Map();
    const buildParts = (id) => {
      const variant = variantOf[id] || 'plain';
      const file = {
        file: variant === 'long-path' ? longPath : id,
        insertions: 12,
        deletions: 3,
        patch: H.workload.patches[id],
        renamed: variant === 'renamed',
        renamedFrom: variant === 'renamed' ? `old/location/${id}` : null,
      };
      const wrapper = manager.renderFileDiff(file);
      const header = wrapper.querySelector('.d2h-file-header');
      const zone = wrapper.querySelector('.file-comments-zone');
      if (variant === 'comment-indicator') {
        // What FileCommentManager.updateCommentCount does to the header icon.
        header.querySelector('.comment-icon-outline').style.display = 'none';
        header.querySelector('.comment-icon-filled').style.display = '';
        header.querySelector('.file-header-comment-btn').classList.add('has-comments');
      }
      return { variant, header, zone, classes: [...wrapper.classList].filter((c) => c !== 'd2h-file-wrapper') };
    };

    // ---- main's natural header height, per variant, on main's own structure ----
    const natural = {};
    const probe = document.createElement('div');
    probe.className = 'd2h-file-wrapper';
    probe.dataset.fileName = 'probe';
    container.appendChild(probe);
    for (const id of names) {
      const built = buildParts(id);
      parts.set(id, built);
      probe.replaceChildren(built.header);
      natural[built.variant] = built.header.getBoundingClientRect().height;
    }
    const wrapperMarginOnMain = getComputedStyle(probe).marginBottom;
    probe.remove();
    const token = natural.plain;

    // ---- the app's code row height ----
    // pr.css sets --diffs-font-size (12px) and --diffs-line-height (1.45) on
    // every <diffs-container>; custom properties cross the shadow boundary, so
    // in this app the vendor's rows are NOT its default 20 px. The vendor's
    // estimate for rows it has not mounted, itemMetrics.lineHeight, has to be
    // the same number.
    //
    // It is measured from a probe row, not multiplied out: 12 x 1.45 is 17.4,
    // the browser lays the row out at 17.390625 px (layout units are 1/64 px),
    // and the vendor's validator compares heights with strict equality.
    const metricsProbe = document.createElement('diffs-container');
    container.appendChild(metricsProbe);
    const probeStyle = getComputedStyle(metricsProbe);
    const cssFontSize = probeStyle.getPropertyValue('--diffs-font-size').trim();
    const cssLineHeight = probeStyle.getPropertyValue('--diffs-line-height').trim();
    metricsProbe.remove();
    const probeRow = document.createElement('div');
    probeRow.style.cssText = `font-size: ${cssFontSize}; line-height: ${cssLineHeight}; font-family: monospace; position: absolute; visibility: hidden;`;
    probeRow.textContent = 'x';
    container.appendChild(probeRow);
    const measuredRowHeight = probeRow.getBoundingClientRect().height;
    probeRow.remove();
    const lineHeight = lineHeightMode === 'vendor-default' ? 20 : measuredRowHeight;

    // ---- the candidate CSS and the header token ----
    const style = document.createElement('style');
    style.textContent = candidateCss;
    document.head.appendChild(style);
    document.documentElement.style.setProperty('--pr-file-header-height', `${token}px`);
    view.classList.add('codeview-engine');

    // ---- real cards from main's bridge ----
    const bridge = new window.PierreBridge({ theme });
    const formElements = new Map();
    const comment = (id, line) => ({
      id, file: names[0], line_start: line, line_end: line, side: 'RIGHT', source: 'user', type: 'comment',
      body: 'A real user comment card, rendered by main\'s bridge.\n\nSecond paragraph.',
    });
    H.hooks.renderAnnotation = (annotation, fileOrDiff, context) => {
      const meta = annotation.metadata;
      if (H.annEls.has(meta.key)) return H.annEls.get(meta.key);
      let el;
      if (meta.kind === 'zone') el = parts.get(context.item.id).zone;
      else if (meta.kind === 'comment') el = bridge._renderCommentAnnotation(comment(meta.id, annotation.lineNumber), `comment-${meta.id}`);
      else if (meta.kind === 'form') el = bridge._renderFormAnnotation({ lineStart: annotation.lineNumber, lineEnd: annotation.lineNumber, side: 'RIGHT' }, `form-${meta.id}`, formElements, context.item.id);
      else if (meta.kind === 'suggestion') el = bridge._renderSuggestionFallback({ id: meta.id, type: 'bug', title: 'A suggestion', body: 'Suggestion body text.' }, `suggestion-${meta.id}`);
      H.annEls.set(meta.key, el);
      return el;
    };
    H.hooks.renderCustomHeader = (fileOrDiff, context) => {
      const id = context.item.id;
      if (!H.headerEls.has(id)) {
        const slotRoot = document.createElement('div');
        slotRoot.className = 'pr-file-header-slot';
        slotRoot.appendChild(parts.get(id).header);
        H.headerEls.set(id, slotRoot);
      }
      return H.headerEls.get(id);
    };
    const MANAGED = ['collapsed', 'generated-file', 'summaries-hidden-file'];
    H.hooks.onPostRender = (node, instance, phase, context) => {
      if (phase === 'unmount') {
        node.removeAttribute('data-file-name');
        node.classList.remove('d2h-file-wrapper', ...MANAGED);
        return;
      }
      node.setAttribute('data-file-name', context.item.id);
      node.classList.add('d2h-file-wrapper');
      for (const name of MANAGED) node.classList.toggle(name, parts.get(context.item.id).classes.includes(name));
    };

    // ---- items ----
    H.parse({});
    H.buildItems({ only: [roles.binary, ...names, roles.deleted] });
    for (const id of [roles.binary, roles.deleted]) parts.set(id, buildParts(id));
    let nextId = 1;
    for (const item of H.items) {
      const built = parts.get(item.id);
      item.collapsed = built.classes.includes('collapsed');
      const side = item.fileDiff.type === 'deleted' ? 'deletions' : 'additions';
      item.annotations = [{ side, lineNumber: 0, metadata: { key: `zone:${item.id}`, kind: 'zone' } }];
      const hunk = item.fileDiff.hunks[0];
      if (!hunk || side === 'deletions') continue;
      const line = hunk.additionStart + 1;
      const kinds = ['comment', 'suggestion', 'form'];
      const kind = kinds[nextId % kinds.length];
      item.annotations.push({ side, lineNumber: line, metadata: { key: `${kind}:${nextId}`, kind, id: 9000 + nextId } });
      nextId++;
    }
    // One zone with a card in it, so the zone's "has content" rules apply.
    const filled = names[7];
    parts.get(filled).zone.querySelector('.file-comments-container')
      .appendChild(bridge._renderCommentAnnotation({ ...comment(8999, 1), is_file_level: 1, line_start: null, line_end: null }, 'comment-8999'));

    H.root = container;
    H.create({
      ...H.APP_OPTIONS,
      themeType: theme,
      diffStyle,
      pointerEventsOnScroll: true,
      unsafeCSS: `${window.PierreBridge.ANNOTATION_CSS}\n${rowlessFix}`,
      itemMetrics: { diffHeaderHeight: token, lineHeight },
      layout: { paddingTop: 16, paddingBottom: 16, gap: 24 },
    }, H.APP_CALLBACKS);
    H.cv.setItems(H.items);
    await H.settle(200);

    window.G9 = { names, variantOf, parts, filled };
    const sampleRow = [...H.cv.getRenderedItems()].map((r) => r.element.shadowRoot.querySelector('[data-content] > [data-line]')).find(Boolean);
    return {
      natural,
      token,
      wrapperMarginOnMain,
      items: H.items.length,
      cssFontSize,
      cssLineHeight,
      measuredRowHeight,
      lineHeight,
      renderedRowHeight: sampleRow ? sampleRow.getBoundingClientRect().height : null,
    };
  }, { theme, diffStyle, lineHeightMode, candidateCss: CANDIDATE_CSS, rowlessFix: ROWLESS_FIX });
}

/** Scroll through the whole list and audit every screen. */
async function walkAndAudit(page) {
  return page.evaluate(async () => {
    const H = window.H;
    const seen = new Map();
    let unclean = 0;
    let steps = 0;
    const visit = async () => {
      await H.settle(80);
      if (!H.auditClean()) unclean++;
      const rootBox = H.root.getBoundingClientRect();
      const rendered = H.cv.getRenderedItems();
      for (let i = 0; i < rendered.length; i++) {
        const { id, element } = rendered[i];
        const slotRoot = element.querySelector('.pr-file-header-slot');
        const header = slotRoot && slotRoot.querySelector('.d2h-file-header');
        const shadowHeader = element.shadowRoot.querySelector('[data-diffs-header]');
        const info = seen.get(id) || {};
        info.variant = window.G9.parts.get(id).variant;
        info.slotHeight = slotRoot ? slotRoot.getBoundingClientRect().height : null;
        info.shadowHeaderHeight = shadowHeader ? shadowHeader.getBoundingClientRect().height : null;
        info.headerPosition = header ? getComputedStyle(header).position : null;
        info.hostMarginBottom = getComputedStyle(element).marginBottom;
        info.hostClasses = [...element.classList].sort().join(' ');
        // Content the fixed height would clip.
        info.headerOverflows = header ? header.scrollHeight > header.clientHeight + 1 : null;
        if (i + 1 < rendered.length) {
          info.gapToNext = Math.round(rendered[i + 1].element.getBoundingClientRect().top - element.getBoundingClientRect().bottom);
        }
        // Cards are inside the host and never wider than it.
        const cards = [...element.querySelectorAll('[data-annotation-slot] > *')].filter((card) => card.getBoundingClientRect().height > 0);
        info.cardHeights = cards.map((card) => `${card.className.split(' ')[0]}:${Math.round(card.getBoundingClientRect().height)}`);
        info.cardWiderThanHost = cards.some((card) => card.getBoundingClientRect().right > rootBox.right + 1);
        seen.set(id, info);
      }
      steps++;
    };
    H.root.scrollTop = 0;
    await visit();
    while (H.root.scrollTop < H.root.scrollHeight - H.root.clientHeight - 1 && steps < 300) {
      H.root.scrollTop += 600;
      await visit();
    }
    return {
      steps,
      unclean,
      orphans: H.orphanHosts(),
      rootIsScroller: H.root.id === 'diff-container' && H.root.scrollHeight > H.root.clientHeight,
      viewOverflow: getComputedStyle(H.root.parentElement).overflowY,
      perItem: Object.fromEntries(seen),
      itemsSeen: seen.size,
    };
  });
}

for (const theme of ['light', 'dark']) {
  for (const diffStyle of ['unified', 'split']) {
    test(`G9: the app's real header, cards and pr.css give an exact layout (${theme}, ${diffStyle})`, async ({ harness }, testInfo) => {
      testInfo.setTimeout(120000);
      const page = await harness.open({ styles: APP_STYLES, scripts: APP_SCRIPTS });
      const setup = await setUpAppShapedViewer(page, { theme, diffStyle });
      const walk = await walkAndAudit(page);

      // Main's wrapper margin is what layout.gap replaces.
      expect(setup.wrapperMarginOnMain).toBe('24px');
      // One header height for every variant: the vendor has ONE header metric.
      const heights = Object.values(setup.natural);
      expect(heights.every((h) => h === setup.token), JSON.stringify(setup.natural)).toBe(true);

      expect(walk.itemsSeen).toBe(setup.items);
      expect(walk.rootIsScroller).toBe(true);
      expect(walk.viewOverflow).toBe('hidden');
      expect(walk.unclean).toBe(0);
      expect(walk.orphans).toBe(0);
      const variantsSeen = new Set();
      for (const [id, info] of Object.entries(walk.perItem)) {
        variantsSeen.add(info.variant);
        expect(info.slotHeight, id).toBe(setup.token);
        expect(info.shadowHeaderHeight, id).toBe(setup.token);
        expect(info.headerPosition, id).toBe('static');
        expect(info.headerOverflows, id).toBe(false);
        expect(info.hostMarginBottom, id).toBe('0px');
        expect(info.hostClasses, id).toContain('d2h-file-wrapper');
        if (info.gapToNext !== undefined) expect(info.gapToNext, id).toBe(24);
        expect(info.cardWiderThanHost, id).toBe(false);
      }
      expect([...variantsSeen].sort()).toEqual(['comment-indicator', 'generated', 'long-path', 'plain', 'renamed', 'summary-toggle', 'viewed']);

      // The same list with a tour active (body.tour-active changes annotation-slot rules).
      await page.evaluate(async () => {
        document.body.classList.add('tour-active');
        window.H.root.scrollTop = 0;
        await window.H.settle(150);
      });
      const tourWalk = await walkAndAudit(page);
      expect(tourWalk.unclean).toBe(0);
      expect(tourWalk.orphans).toBe(0);

      // The app's rows are not the vendor's default 20 px.
      expect(setup.cssFontSize).toBe('12px');
      expect(setup.cssLineHeight).toBe('1.45');
      expect(setup.renderedRowHeight).toBe(setup.measuredRowHeight);
      expect(setup.measuredRowHeight).not.toBe(20);

      await harness.record(`G9-app-css-${theme}-${diffStyle}`, {
        requiredItemMetrics: { diffHeaderHeight: setup.token, lineHeight: setup.lineHeight },
        requiredLayout: { paddingTop: 16, paddingBottom: 16, gap: 24 },
        candidateCss: CANDIDATE_CSS.trim().split('\n'),
        rowHeight: { cssFontSize: setup.cssFontSize, cssLineHeight: setup.cssLineHeight, measuredPx: setup.measuredRowHeight },
        naturalHeaderHeightOnMainPx: setup.natural,
        headerTokenPx: setup.token,
        wrapperMarginOnMain: setup.wrapperMarginOnMain,
        items: setup.items,
        screensAudited: walk.steps + tourWalk.steps,
        uncleanScreens: walk.unclean + tourWalk.unclean,
        validatorErrors: harness.validatorErrors(page).length,
        cardHeights: Object.fromEntries(Object.entries(walk.perItem).map(([id, info]) => [id, info.cardHeights])),
      });
    });
  }
}

test('G9 (why lineHeight is passed): with the vendor\'s default 20 px row estimate the app\'s 17.39 px rows drift', async ({ harness }, testInfo) => {
  // The same viewer with itemMetrics.lineHeight left at the vendor default.
  // The vendor then estimates unmounted rows at 20 px while pr.css renders
  // them at 17.39 px; its own validator reports the difference and items end
  // up away from where the vendor thinks they are. This is the measurement
  // that says the bridge must pass a measured lineHeight.
  testInfo.setTimeout(120000);
  const page = await harness.open({ styles: APP_STYLES, scripts: APP_SCRIPTS });
  harness.allowErrors(page, VALIDATOR_PATTERN);
  const setup = await setUpAppShapedViewer(page, { theme: 'light', diffStyle: 'unified', lineHeightMode: 'vendor-default' });
  const walk = await walkAndAudit(page);
  expect(setup.lineHeight).toBe(20);
  expect(setup.renderedRowHeight).toBeLessThan(18);
  expect(walk.unclean).toBeGreaterThan(0);
  expect(harness.validatorErrors(page).length).toBeGreaterThan(0);
});
