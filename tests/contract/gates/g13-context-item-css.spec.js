// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Gate G13 (plans/codeview-virtualized-diff.md): a context file as an item of
 * the viewer, built by the REAL bridge, under the APP's real CSS.
 *
 * The probes for decision D2 measured the design with a stand-in for the
 * gutter buttons and with the split card class set by hand. This gate closes
 * that gap. Everything here is production's:
 *
 *  - public/css/pr.css, unmodified, plus the CSS the cut-over adds
 *    (CANDIDATE_CSS, the same text gate G9 uses)
 *  - PierreCodeViewBridge with its own unsafeCSS (ANNOTATION_CSS, ROWLESS_FIX,
 *    CONTEXT_CSS), its own metrics (the header token and a measured row
 *    height), its gutter buttons and its split card layout pass
 *  - the changed-file header built by PRManager.renderFileDiff and the
 *    context-file header built by PRManager.renderContextFile
 *  - the file-comment zone of FileCommentManager, and comment, suggestion and
 *    form cards from the shared renderers
 *
 * The verdict is the development bundle's height validator plus the harness
 * audit, in light and dark, unified and split, with wrapped lines, after a
 * real click on every separator control, a real click on a gutter button, and
 * a walk of the whole list.
 */

import { test, expect, openBridge, clickExpandControl } from '../bridge/bridge-test.js';
import { CANDIDATE_CSS } from '../harness/constants.js';

const APP_STYLES = ['/app/css/pr.css'];
const APP_BEFORE = ['/app/js/utils/smart-truncate.js', '/app/js/modules/diff-renderer.js', '/app/js/utils/posted-comment.js'];
const APP_AFTER = ['/app/js/modules/file-comment-manager.js', '/app/js/pr.js'];
const CONTEXT = 'src/mod01/shared-helpers.js';

/** Build the app-shaped page around the real bridge. Runs in the page. */
async function setUp(page, { theme, diffStyle }) {
  return page.evaluate(async ({ theme, diffStyle, candidateCss, CONTEXT }) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    document.documentElement.setAttribute('data-theme', theme);

    // ---- the real headers and zones, from a PRManager that was never constructed ----
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
    manager.contextFiles = [];
    manager.fileCommentManager = new window.FileCommentManager(manager);
    manager._getPierreRenderDecision = () => ({ usePierre: true, forcePlainText: false, deferDiff: false });
    // renderContextFile builds the header, then the legacy table body. Only
    // the header is wanted: the body builders answer empty elements.
    manager.fetchFileContent = async () => ({ lines: ['x'] });
    manager._buildContextChunkTbody = () => document.createElement('tbody');

    const diffA = roles.small;
    const diffB = roles.medium;
    const parts = new Map();
    for (const id of [diffA, diffB]) {
      const wrapper = manager.renderFileDiff({ file: id, insertions: 12, deletions: 3, patch: H.workload.patches[id] });
      parts.set(id, { header: wrapper.querySelector('.d2h-file-header'), zone: wrapper.querySelector('.file-comments-zone') });
    }
    // renderContextFile appends its wrapper to #diff-container: give it a scratch one.
    const scratch = document.createElement('div');
    scratch.id = 'diff-container';
    document.body.appendChild(scratch);
    await manager.renderContextFile({ id: 1, file: CONTEXT, line_start: 100, line_end: 120, label: 'why this file is here' });
    const contextWrapper = scratch.querySelector('.d2h-file-wrapper.context-file');
    parts.set(CONTEXT, { header: contextWrapper.querySelector('.d2h-file-header'), zone: contextWrapper.querySelector('.file-comments-zone') });
    const contextHeaderHeightOnMain = parts.get(CONTEXT).header.getBoundingClientRect().height;
    scratch.remove();

    // ---- layout: .main-layout > main.diff-view.codeview-engine > #diff-container (pr.html) ----
    const layout = document.createElement('div');
    layout.className = 'main-layout';
    layout.style.cssText = 'height: 100vh; width: 100vw;';
    const view = document.createElement('main');
    view.className = 'diff-view codeview-engine';
    const container = document.createElement('div');
    container.id = 'diff-container';
    container.className = 'diff-container';
    view.appendChild(container);
    layout.appendChild(view);
    document.body.replaceChildren(layout);
    const style = document.createElement('style');
    style.textContent = candidateCss;
    document.head.appendChild(style);
    document.documentElement.style.setProperty('--pr-file-header-height', '45px');

    // ---- the real bridge, measuring its own metrics ----
    H.root = container;
    const gutterClicks = [];
    const bridge = new window.PierreCodeViewBridge({
      root: container,
      theme,
      diffStyle,
      workerUrl: '/vendor/pierre-diffs-worker.js',
      viewerOptions: { __devOnlyValidateItemHeights: true },
      hooks: {
        renderHeader: (id) => parts.get(id).header,
        onItemLifecycle: (id, phase) => H.log('onPostRender', { id, phase }),
      },
      collaborators: { PostedComment: window.PostedComment, escapeHtml: (text) => String(text).replace(/</g, '&lt;') },
      onCommentClick: (file, line, side) => gutterClicks.push([file, line, side]),
      onChatClick: () => {},
    });
    bridge.registerAnnotationRenderer('file-comments', (data) => parts.get(data.file).zone);
    BH.bridge = bridge;

    // Every seventh line of the context file wraps.
    const tail = ` ${'a very long trailing comment that has to wrap in a narrow column '.repeat(6)}`;
    const contents = `${Array.from({ length: 400 }, (_, i) => `const value${i + 1} = compute(${i + 1}); // line ${i + 1}${i % 7 === 3 ? tail : ''}`).join('\n')}\n`;
    bridge.renderAll([
      BH.diffEntry(diffA),
      BH.contextEntry(CONTEXT, { contents, ranges: [{ startLine: 100, endLine: 120 }, { startLine: 300, endLine: 310 }] }),
      BH.diffEntry(diffB),
    ], { keyPrefix: 'rev1' });
    H.cv = bridge.codeView;
    await H.settle(250, 15000);

    // Real cards on context lines and in the context file's zone.
    const comment = (id, line, extra = {}) => ({ id, file: CONTEXT, line_start: line, line_end: line, side: 'RIGHT', body: 'A user comment on a context line.\n\nSecond paragraph.', ...extra });
    bridge.batch(() => {
      bridge.addAnnotation(CONTEXT, { lineNumber: 105, side: 'RIGHT', type: 'comment', data: comment(1, 105), id: 'comment-1' });
      bridge.addAnnotation(CONTEXT, { lineNumber: 110, side: 'LEFT', type: 'comment', data: comment(2, 110, { side: 'LEFT' }), id: 'comment-2' });
      bridge.addAnnotation(CONTEXT, { lineNumber: 115, side: 'RIGHT', type: 'comment-form', data: { lineStart: 115, lineEnd: 115, side: 'RIGHT' }, id: 'form-1' });
      bridge.addAnnotation(CONTEXT, { lineNumber: 305, side: 'RIGHT', type: 'suggestion', data: { id: 9, file: CONTEXT, line_start: 305, type: 'bug', title: 'A finding', body: 'Suggestion body.' }, id: 'suggestion-9' });
    });
    parts.get(CONTEXT).zone.querySelector('.file-comments-container')
      .appendChild(window.PierreAnnotations.renderComment({ ...comment(3, null), is_file_level: 1, line_start: null, line_end: null }, 'comment-3', { PostedComment: window.PostedComment }));
    bridge.scrollToItem(CONTEXT);
    await H.settle(300);

    window.G13 = { parts, gutterClicks, diffA, diffB };
    const host = bridge.findFileElement(CONTEXT);
    const row = host.shadowRoot.querySelector('[data-content] > [data-line]');
    return {
      contextHeaderHeightOnMain,
      metrics: bridge._metrics,
      renderedRowHeight: row.getBoundingClientRect().height,
      hostClasses: [...host.classList].sort(),
      slotHeight: host.querySelector('.pr-file-header-slot').getBoundingClientRect().height,
      shadowHeaderHeight: host.shadowRoot.querySelector('[data-diffs-header]').getBoundingClientRect().height,
      hostMarginBottom: getComputedStyle(host).marginBottom,
      hostBorderLeft: getComputedStyle(host).borderLeftWidth,
      badge: host.querySelector('.context-badge')?.textContent ?? null,
    };
  }, { theme, diffStyle, candidateCss: CANDIDATE_CSS, CONTEXT });
}

/** Scroll through the whole list and audit every screen. */
async function walkAndAudit(page) {
  return page.evaluate(async () => {
    const { H } = window;
    let unclean = 0;
    let steps = 0;
    H.root.scrollTop = 0;
    for (;;) {
      await H.settle(80);
      if (!H.auditClean()) unclean++;
      steps++;
      if (H.root.scrollTop >= H.root.scrollHeight - H.root.clientHeight - 1 || steps > 300) break;
      H.root.scrollTop += 500;
    }
    return { steps, unclean, orphans: H.orphanHosts() };
  });
}

for (const theme of ['light', 'dark']) {
  for (const diffStyle of ['unified', 'split']) {
    test(`G13: a context item built by the bridge, with the app's header, gutter buttons, cards and pr.css, has an exact layout (${theme}, ${diffStyle})`, async ({ harness }, testInfo) => {
      testInfo.setTimeout(120000);
      const page = await openBridge(harness, { styles: APP_STYLES, before: APP_BEFORE, after: APP_AFTER });
      const setup = await setUp(page, { theme, diffStyle });

      // The context header is as tall as a changed file's: the viewer has ONE header metric.
      expect(setup.contextHeaderHeightOnMain).toBe(45);
      expect(setup.metrics.diffHeaderHeight).toBe(45);
      // The bridge measured the app's row height itself, and rows are that tall.
      expect(setup.metrics.lineHeight).toBe(setup.renderedRowHeight);
      expect(setup.metrics.lineHeight).not.toBe(20);
      expect(setup.hostClasses).toEqual(['context-file', 'd2h-file-wrapper']);
      expect(setup.slotHeight).toBe(45);
      expect(setup.shadowHeaderHeight).toBe(45);
      expect(setup.hostMarginBottom).toBe('0px');
      expect(setup.badge).toBe('CONTEXT');

      const before = await page.evaluate(async (CONTEXT) => {
        const { H, BH } = window;
        const b = BH.bridge;
        const host = b.findFileElement(CONTEXT);
        const hostBox = host.getBoundingClientRect();
        const pre = host.shadowRoot.querySelector('pre');
        const cell = (id) => { const box = b.getAnnotationElement(CONTEXT, id).closest('[data-annotation-slot]').getBoundingClientRect(); return { left: Math.round(box.left - hostBox.left), right: Math.round(hostBox.right - box.right), height: Math.round(box.height) }; };
        const gutterWidth = Math.round(pre.querySelector('[data-gutter]').getBoundingClientRect().width);
        return {
          columns: [...pre.querySelectorAll('code')].map((c) => ['data-unified', 'data-additions', 'data-deletions'].find((a) => c.hasAttribute(a))),
          rows: host.shadowRoot.querySelectorAll('[data-content] > [data-line]').length,
          columnWidth: Math.round(pre.querySelector('code').getBoundingClientRect().width),
          hostWidth: Math.round(hostBox.width),
          gutterWidth,
          cells: { comment: cell('comment-1'), left: cell('comment-2'), form: cell('form-1') },
          clean: H.auditClean(),
        };
      }, CONTEXT);
      // One column as wide as the host in both layouts, every line once.
      expect(before.columns).toEqual([diffStyle === 'split' ? 'data-additions' : 'data-unified']);
      expect(before.rows).toBe(32);
      // (The host has the context file's 3 px left border; the column fills what is inside it.)
      expect(before.hostWidth - before.columnWidth).toBeLessThanOrEqual(4);
      // Cards span the content track: from the gutter to the right edge. A comment stored LEFT too.
      for (const [name, box] of Object.entries(before.cells)) {
        expect(box.height, name).toBeGreaterThan(0);
        expect(box.right, name).toBeLessThanOrEqual(1);
        expect(Math.abs(box.left - before.gutterWidth), name).toBeLessThanOrEqual(4);
      }
      expect(before.clean).toBe(true);

      // The app's gutter buttons on a context line: hover with the real pointer, click the comment button.
      const point = await page.evaluate(async (CONTEXT) => {
        window.BH.bridge.scrollToLine(CONTEXT, 118, 'RIGHT', { behavior: 'instant', flash: false });
        await window.H.settle(200);
        const box = window.H.findRow(CONTEXT, 118, 'additions').getBoundingClientRect();
        return { x: Math.round(box.left + 300), y: Math.round(box.top + box.height / 2) };
      }, CONTEXT);
      await page.mouse.move(point.x, point.y - 3);
      await page.mouse.move(point.x, point.y);
      await page.evaluate(() => window.H.raf(3));
      const gutter = await page.evaluate((CONTEXT) => {
        const el = window.BH.bridge.findFileElement(CONTEXT).querySelector('[slot="gutter-utility-slot"] .pierre-gutter-buttons');
        const box = el.querySelector('.pierre-comment-btn').getBoundingClientRect();
        return { shown: box.height > 0, x: box.left + box.width / 2, y: box.top + box.height / 2, hovered: window.BH.bridge.getHoveredRow(CONTEXT) };
      }, CONTEXT);
      expect(gutter.shown).toBe(true);
      expect(gutter.hovered).toEqual({ lineNumber: 118, side: 'RIGHT' });
      await page.mouse.click(gutter.x, gutter.y);
      expect(await page.evaluate(() => window.G13.gutterClicks)).toEqual([[CONTEXT, 118, 'RIGHT']]);

      // A real click on every control: step after the last range, step before
      // the first, both sides between the ranges, Shift+click, "Expand all".
      for (const [index, kind, options] of [[2, 'up'], [0, 'down'], [1, 'down'], [1, 'up'], [0, 'down', { shift: true }], [1, 'all'], [2, 'all']]) {
        const box = await clickExpandControl(page, CONTEXT, index, kind, options);
        expect(box && box.visible, `${kind} at gap ${index}: ${JSON.stringify(box)}`).toBe(true);
      }
      const expanded = await page.evaluate((CONTEXT) => [1, 99, 121, 299, 311, 400].map((n) => window.BH.bridge.isLineVisible(CONTEXT, n, 'RIGHT')), CONTEXT);
      expect(expanded).toEqual([true, true, true, true, true, true]);

      const walk = await walkAndAudit(page);
      expect(walk.unclean).toBe(0);
      expect(walk.orphans).toBe(0);

      // The same after a reveal folded the manual expansions into ranges.
      await page.evaluate(async (CONTEXT) => {
        const { H, BH } = window;
        BH.bridge.addContextRanges(CONTEXT, [{ startLine: 1, endLine: 400 }]);
        await BH.displayed(CONTEXT);
        await H.settle(200);
      }, CONTEXT);
      const folded = await walkAndAudit(page);
      expect(folded.unclean).toBe(0);
      expect(harness.validatorErrors(page)).toEqual([]);

      await harness.record(`G13-context-item-${theme}-${diffStyle}`, {
        metrics: setup.metrics,
        contextHeaderHeightOnMainPx: setup.contextHeaderHeightOnMain,
        columns: before.columns,
        rows: before.rows,
        hostWidth: before.hostWidth,
        columnWidth: before.columnWidth,
        cardCells: before.cells,
        controlsClicked: 7,
        screensAudited: walk.steps + folded.steps,
        uncleanScreens: walk.unclean + folded.unclean,
        orphans: walk.orphans,
        validatorErrors: harness.validatorErrors(page).length,
      });
    });
  }
}
