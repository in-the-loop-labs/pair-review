// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Bridge-in-browser: annotations. What a publish guarantees, the element
 * cache, sync on a draw and never on a lookup, the flush guard, and the
 * app's real card renderers with collaborators handed in.
 */

import { test, expect, openBridge } from './bridge-test.js';

/** Bring up a few files and return a line of the first one that is on screen. */
async function up(page, options = {}) {
  return page.evaluate(async (options) => {
    const { H, BH } = window;
    const { roles } = H.workload;
    // Thirty modified files: every one has hunks, and the list is several screens long.
    const names = H.workload.modifiedPaths.filter((n) => n !== roles.hugeModified && n !== roles.large).slice(0, 30);
    await BH.up({ entries: names.map((n) => BH.diffEntry(n)), options });
    const hunk = BH.bridge.files.get(names[0]).metadata.hunks[0];
    return { names, file: names[0], line: hunk.additionStart + 1, far: names[25] };
  }, options);
}

test('add, add many, remove, remove by type: the card of a mounted file is attached in the same task', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line } = await up(page);
  const result = await page.evaluate(async ({ file, line }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const out = {};
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'one' }, id: 'card-1' });
    out.afterAdd = BH.cardState(file, 'card-1');
    b.addAnnotations(file, [
      { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'two' }, id: 'card-2' },
      { lineNumber: line + 1, side: 'RIGHT', type: 'card', data: { text: 'three' }, id: 'card-3' },
      { lineNumber: line + 1, side: 'RIGHT', type: 'other', data: {}, id: 'other-1' },
    ]);
    out.afterBatch = ['card-2', 'card-3'].map((id) => BH.cardState(file, id).connected);
    out.generatedId = (() => {
      b.addAnnotation(file, { lineNumber: line + 2, side: 'LEFT', type: 'card', data: { text: 'auto' } });
      return b.getAnnotations(file, 'card').map((a) => a.metadata.id).find((id) => /^card-\d+-deletions-\d+$/.test(id)) || null;
    })();
    out.listed = b.getAnnotations(file).map((a) => a.metadata.id);
    out.zoneListed = b.getAnnotations(file).some((a) => a.metadata.type === 'file-comments');
    out.has = [b.hasAnnotation(file, 'card-1'), b.hasAnnotation(file, 'nope'), b.hasAnnotation('nope.js', 'card-1')];
    out.findFile = [b.findAnnotationFile('card-3'), b.findAnnotationFile('nope'), b.findAnnotationFile('file-comments')];
    out.findByData = b.findAnnotationByData('card', (data) => data.text === 'three')?.fileName ?? null;

    const removedEl = b.getAnnotationElement(file, 'card-1');
    b.removeAnnotation(file, 'card-1');
    out.afterRemove = { held: b.hasAnnotation(file, 'card-1'), connected: removedEl.isConnected, lookup: b.getAnnotationElement(file, 'card-1') };
    b.removeAnnotationsByType(file, 'card');
    out.afterRemoveByType = b.getAnnotations(file).map((a) => a.metadata.id);
    // The file's comment zone is part of the file: it cannot be removed.
    b.removeAnnotation(file, 'file-comments');
    b.removeAnnotationsByType(file, 'file-comments');
    out.zoneStill = b.codeView.getItem(file).annotations[0].metadata.type;
    // A file the bridge does not hold: nothing happens, nothing throws.
    b.addAnnotation('nope.js', { lineNumber: 1, side: 'RIGHT', type: 'card', data: {} });
    b.addAnnotations(file, []);
    b.removeAnnotation('nope.js', 'x');
    out.unknownFile = b.getAnnotations('nope.js');
    await H.settle(100);
    out.sound = BH.sound();
    return out;
  }, { file, line });

  expect(result.afterAdd).toMatchObject({ built: true, connected: true, slot: `annotation-additions-${line}`, host: file });
  expect(result.afterBatch).toEqual([true, true]);
  expect(result.generatedId).not.toBeNull();
  expect(result.listed).toEqual(expect.arrayContaining(['card-1', 'card-2', 'card-3', 'other-1']));
  expect(result.zoneListed).toBe(false);
  expect(result.has).toEqual([true, false, false]);
  expect(result.findFile).toEqual([file, null, null]);
  expect(result.findByData).toBe(file);
  expect(result.afterRemove).toEqual({ held: false, connected: false, lookup: null });
  expect(result.afterRemoveByType).toEqual(['other-1']);
  expect(result.zoneStill).toBe('file-comments');
  expect(result.unknownFile).toEqual([]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('cards on one line are drawn in the app\'s order, whatever order they were added in', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line } = await up(page);
  const order = await page.evaluate(async ({ file, line }) => {
    const { BH } = window;
    const b = BH.bridge;
    for (const type of ['external-comment', 'comment-like', 'tour-stop', 'hunk-summary']) {
      b.registerAnnotationRenderer(type, (data, id) => {
        const el = document.createElement('div');
        el.className = 'ann';
        el.dataset.cardId = id;
        return el;
      });
    }
    b.batch(() => {
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'external-comment', data: {}, id: 'ext' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'comment-form', data: { lineStart: line, lineEnd: line, side: 'RIGHT' }, id: 'form' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'tour-stop', data: {}, id: 'tour' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'hunk-summary', data: {}, id: 'summary' });
    });
    const slot = BH.bridge.findFileElement(file).querySelectorAll(`[data-annotation-slot][slot="annotation-additions-${line}"] > *`);
    return [...slot].map((el) => el.dataset.cardId || el.dataset.annotationId);
  }, { file, line });
  expect(order).toEqual(['summary', 'tour', 'form', 'ext']);
});

test('a card is built once, re-attached after its file left the window, and synced on every draw but never by a lookup', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line, far } = await up(page);
  const result = await page.evaluate(async ({ file, line, far }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const data = { text: 'kept', n: 1, textarea: true };
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'card', data, id: 'card-1' });
    const el = b.getAnnotationElement(file, 'card-1');
    el.querySelector('textarea').value = 'typed by the reader';
    el.dataset.readerState = 'open';
    const syncsAfterBuild = BH.synced.length;

    // A lookup of a card that exists changes nothing, also when the data moved on.
    data.n = 2;
    const looked = b.getAnnotationElement(file, 'card-1', { create: true });
    const afterLookup = { same: looked === el, syncs: BH.synced.length - syncsAfterBuild, stamped: el.dataset.syncedN };

    // Away and back: the file unmounts, its host is recycled, the card detaches.
    b.scrollToItem(far);
    await H.settle(300);
    const away = { mounted: b.findFileElement(file) !== null, connected: el.isConnected, lookup: b.getAnnotationElement(file, 'card-1') === el };
    b.scrollToItem(file);
    await H.settle(300);
    return {
      builds: BH.cardBuilds,
      syncsAfterBuild,
      afterLookup,
      away,
      back: {
        connected: el.isConnected,
        same: b.getAnnotationElement(file, 'card-1') === el,
        value: el.querySelector('textarea').value,
        readerState: el.dataset.readerState,
        // The draw on remount brought the card in line with its data.
        stamped: el.dataset.syncedN,
        syncedOnRemount: BH.synced.length > syncsAfterBuild,
      },
      sound: BH.sound(),
    };
  }, { file, line, far });

  expect(result.builds).toBe(1);
  expect(result.syncsAfterBuild).toBeGreaterThanOrEqual(1);
  expect(result.afterLookup).toEqual({ same: true, syncs: 0, stamped: '1' });
  expect(result.away).toEqual({ mounted: false, connected: false, lookup: true });
  expect(result.back).toEqual({ connected: true, same: true, value: 'typed by the reader', readerState: 'open', stamped: '2', syncedOnRemount: true });
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('getAnnotationElement builds the card of a file that was never mounted, and the viewer later draws that element', async ({ harness }) => {
  const page = await openBridge(harness);
  const { far } = await up(page);
  const result = await page.evaluate(async ({ far }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const line = b.files.get(far).metadata.hunks[0].additionStart + 1;
    const everMounted = BH.lifecycle.some((e) => e.id === far);
    b.addAnnotation(far, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: 'far' }, id: 'card-far' });
    const before = b.getAnnotationElement(far, 'card-far');
    const built = b.getAnnotationElement(far, 'card-far', { create: true });
    const builtDetached = !!built && !built.isConnected;
    const waiting = b.whenAnnotationRendered(far, 'card-far', { timeoutMs: 5000 });
    b.scrollToLine(far, line, 'RIGHT', { behavior: 'instant' });
    const rendered = await waiting;
    await H.settle(150);
    return {
      everMounted,
      before,
      builtDetached,
      renderedIsBuilt: rendered === built,
      connected: built.isConnected,
      builds: BH.cardBuilds,
      sound: BH.sound(),
    };
  }, { far });
  expect(result.everMounted).toBe(false);
  expect(result.before).toBeNull();
  expect(result.builtDetached).toBe(true);
  expect(result.renderedIsBuilt).toBe(true);
  expect(result.connected).toBe(true);
  expect(result.builds).toBe(1);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('whenAnnotationRendered answers null at once for a line the file does not show, a collapsed file, and an unknown annotation', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line } = await up(page);
  const result = await page.evaluate(async ({ file, line }) => {
    const { BH } = window;
    const b = BH.bridge;
    const timed = async (promise) => { const t0 = performance.now(); const value = await promise; return { isNull: value === null, fast: performance.now() - t0 < 500 }; };
    b.addAnnotation(file, { lineNumber: 99999, side: 'RIGHT', type: 'card', data: {}, id: 'card-hidden' });
    const hidden = await timed(b.whenAnnotationRendered(file, 'card-hidden'));
    const unknown = await timed(b.whenAnnotationRendered(file, 'nope'));
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'card', data: {}, id: 'card-shown' });
    b.setCollapsed(file, true);
    const collapsed = await timed(b.whenAnnotationRendered(file, 'card-shown'));
    let cancelledAfter = 0;
    b.setCollapsed(file, false);
    const cancelled = await timed(b.whenAnnotationRendered(file, 'card-shown', { isCancelled: () => ++cancelledAfter > 0 }));
    return { hidden, unknown, collapsed, shownAgain: cancelled };
  }, { file, line });
  expect(result.hidden).toEqual({ isNull: true, fast: true });
  expect(result.unknown).toEqual({ isNull: true, fast: true });
  expect(result.collapsed).toEqual({ isNull: true, fast: true });
  // Expanded again and mounted: the card is attached in the same task, before any cancel check.
  expect(result.shownAgain).toEqual({ isNull: false, fast: true });
});

test('a renderer that publishes while the viewer is drawing does not corrupt the layout (flush guard)', async ({ harness }) => {
  const page = await openBridge(harness);
  const { file, line, far } = await up(page);
  const result = await page.evaluate(async ({ file, line, far }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    let publishedFromRenderer = 0;
    b.registerAnnotationRenderer('eager', (data, id) => {
      // What a feature module might do from inside its renderer: add another card.
      if (!b.hasAnnotation(file, 'card-from-renderer')) {
        publishedFromRenderer++;
        b.addAnnotation(file, { lineNumber: line + 2, side: 'RIGHT', type: 'card', data: { text: 'from renderer' }, id: 'card-from-renderer' });
      }
      const el = document.createElement('div');
      el.className = 'ann';
      el.textContent = id;
      return el;
    });
    // The lifecycle hook runs inside the viewer's pass too.
    let publishedFromHook = 0;
    BH.onLifecycle = (id, phase) => {
      if (id === file && phase === 'update' && !b.hasAnnotation(file, 'card-from-hook')) {
        publishedFromHook++;
        b.addAnnotation(file, { lineNumber: line + 3, side: 'RIGHT', type: 'card', data: { text: 'from hook' }, id: 'card-from-hook' });
      }
    };
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'eager', data: {}, id: 'eager-1' });
    const sameTask = BH.cardState(file, 'card-from-renderer').connected;
    await H.settle(150);
    const settled = ['eager-1', 'card-from-renderer', 'card-from-hook'].map((id) => BH.cardState(file, id).connected);
    // Walk away and back: a corrupted layout does not heal.
    b.scrollToItem(far);
    await H.settle(250);
    b.scrollToItem(file);
    await H.settle(250);
    return { publishedFromRenderer, publishedFromHook, sameTask, settled, sound: BH.sound() };
  }, { file, line, far });
  expect(result.publishedFromRenderer).toBe(1);
  expect(result.publishedFromHook).toBe(1);
  // The nested publish is flushed after the pass, not inside it.
  expect(result.sameTask).toBe(false);
  expect(result.settled).toEqual([true, true, true]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
  expect(harness.validatorErrors(page)).toEqual([]);
});

test('batch: many publishes, one flush, and the cards are there when it returns', async ({ harness }) => {
  const page = await openBridge(harness);
  const { names } = await up(page);
  const result = await page.evaluate(async ({ names }) => {
    const { H, BH } = window;
    const b = BH.bridge;
    const cv = b.codeView;
    const originalRender = cv.render.bind(cv);
    const originalUpdate = cv.updateItem.bind(cv);
    let flushes = 0;
    let updates = 0;
    cv.render = (immediate) => { if (immediate) flushes++; return originalRender(immediate); };
    cv.updateItem = (item) => { updates++; return originalUpdate(item); };
    const mounted = H.mounted().slice(0, 2);
    const returned = b.batch(() => {
      for (const id of mounted) {
        const line = b.files.get(id).metadata.hunks[0].additionStart;
        for (let i = 0; i < 5; i++) b.addAnnotation(id, { lineNumber: line, side: 'RIGHT', type: 'card', data: { text: `c${i}` }, id: `card-${id}-${i}` });
      }
      // Nested batches do not flush on their own.
      b.batch(() => b.addAnnotations(mounted[0], [{ lineNumber: b.files.get(mounted[0]).metadata.hunks[0].additionStart, side: 'RIGHT', type: 'card', data: {}, id: 'nested' }]));
      return { flushesInside: flushes };
    });
    const connected = mounted.every((id) => [0, 1, 2, 3, 4].every((i) => BH.cardState(id, `card-${id}-${i}`).connected));
    cv.render = originalRender;
    cv.updateItem = originalUpdate;
    return { returned, flushes, updates, connected, nested: BH.cardState(mounted[0], 'nested').connected };
  }, { names });
  expect(result.returned).toEqual({ flushesInside: 0 });
  expect(result.flushes).toBe(1);
  expect(result.updates).toBe(11);
  expect(result.connected).toBe(true);
  expect(result.nested).toBe(true);
});

test('the app\'s comment, suggestion and form cards are built from collaborators handed to the bridge, with no page manager', async ({ harness }) => {
  const page = await openBridge(harness, {
    before: ['/app/js/utils/posted-comment.js', '/app/js/modules/suggestion-manager.js'],
  });
  const { file, line } = await up(page);
  const result = await page.evaluate(async ({ file, line }) => {
    const { H, BH } = window;
    // The page object the suggestion manager reads its comments from. It is
    // not on window: nothing in the bridge or the shared renderers may need
    // window.prManager.
    const pageState = { userComments: [], escapeHtml: (text) => String(text).replace(/</g, '&lt;') };
    const suggestionManager = new window.SuggestionManager(pageState);
    const submitted = [];
    BH.bridge.destroy();
    H.root.replaceChildren();
    H.cv = null;
    BH.create({
      collaborators: () => ({ suggestionManager, PostedComment: window.PostedComment, escapeHtml: pageState.escapeHtml }),
      onCommentFormSubmit: async (...args) => { submitted.push(args); },
    });
    BH.renderAll([BH.diffEntry(file)]);
    await H.settle(150);
    const b = BH.bridge;
    const comment = { id: 7, file, line_start: line, line_end: line, side: 'RIGHT', body: 'A <b>comment</b>', status: 'active' };
    const suggestion = { id: 11, file, line_start: line, line_end: line, side: 'RIGHT', type: 'bug', title: 'A finding', body: 'Body', status: 'active' };
    b.batch(() => {
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'comment', data: comment, id: 'comment-7' });
      b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'suggestion', data: suggestion, id: 'suggestion-11' });
      b.addAnnotation(file, { lineNumber: line + 1, side: 'RIGHT', type: 'comment-form', data: { lineStart: line + 1, lineEnd: line + 1, side: 'RIGHT', initialValue: 'draft' }, id: 'form-1' });
    });
    const commentEl = b.getAnnotationElement(file, 'comment-7');
    const suggestionEl = b.getAnnotationElement(file, 'suggestion-11');
    const formEl = b.getAnnotationElement(file, 'form-1');
    formEl.querySelector('.save-comment-btn').click();
    await H.raf(2);
    return {
      prManagerOnWindow: 'prManager' in window,
      comment: { cls: commentEl.className, id: commentEl.dataset.commentId, connected: commentEl.isConnected, escaped: commentEl.querySelector('.user-comment-body').innerHTML.includes('&lt;b&gt;') },
      suggestion: { cls: suggestionEl.className, id: suggestionEl.dataset.suggestionId, connected: suggestionEl.isConnected },
      form: { cls: formEl.className, value: formEl.querySelector('textarea').value, connected: formEl.isConnected, sameOnLookup: b.getAnnotationElement(file, 'form-1', { create: true }) === formEl },
      submitted: submitted.map(([f, id, data, text]) => [f, id, data.lineStart, text]),
      sound: BH.sound(),
    };
  }, { file, line });
  expect(result.prManagerOnWindow).toBe(false);
  expect(result.comment).toEqual({ cls: 'user-comment-row', id: '7', connected: true, escaped: true });
  expect(result.suggestion.cls).toContain('ai-suggestion');
  expect(result.suggestion).toMatchObject({ id: '11', connected: true });
  expect(result.form).toEqual({ cls: 'pierre-annotation user-comment-form', value: 'draft', connected: true, sameOnLookup: true });
  expect(result.submitted).toEqual([[file, 'form-1', line + 1, 'draft']]);
  expect(result.sound).toEqual({ orphans: 0, clean: true });
});

test('a suggestion whose status changed while its card was untouched shows it at the next draw, and a card the reader re-opened stays open', async ({ harness }) => {
  // The comment-restore scenario (ledger H71): a comment that adopted a
  // suggestion is deleted (the suggestion becomes dismissed, the flow updates
  // the card) and later restored. Restoring reloads the comments and touches
  // no card; the data now says "adopted" while the card still shows
  // "dismissed". The card is corrected by the next draw. Under CodeView every
  // remount is such a draw. The second half is the other rule of H71: state
  // the reader put on a card (an adopted suggestion shown again) is not
  // undone by a draw, because the flow recorded the card as showing its status.
  const page = await openBridge(harness, {
    before: ['/app/js/utils/posted-comment.js', '/app/js/modules/suggestion-manager.js'],
  });
  const { file, line, far } = await up(page);
  const result = await page.evaluate(async ({ file, line, far }) => {
    const { H, BH } = window;
    const pageState = { userComments: [], escapeHtml: (text) => text };
    const suggestionManager = new window.SuggestionManager(pageState);
    BH.bridge.destroy();
    H.root.replaceChildren();
    H.cv = null;
    BH.create({ collaborators: { suggestionManager, PostedComment: window.PostedComment, escapeHtml: pageState.escapeHtml } });
    const names = H.workload.modifiedPaths.filter((n) => n !== H.workload.roles.hugeModified && n !== H.workload.roles.large).slice(0, 30);
    BH.renderAll(names.map((n) => BH.diffEntry(n)));
    await H.settle(150);
    const b = BH.bridge;
    const restored = { id: 21, file, line_start: line, line_end: line, side: 'RIGHT', type: 'bug', title: 'Restored', body: 'x', status: 'dismissed' };
    const reopened = { id: 22, file, line_start: line + 1, line_end: line + 1, side: 'RIGHT', type: 'bug', title: 'Re-opened', body: 'y', status: 'adopted' };
    b.addAnnotations(file, [
      { lineNumber: line, side: 'RIGHT', type: 'suggestion', data: restored, id: 'suggestion-21' },
      { lineNumber: line + 1, side: 'RIGHT', type: 'suggestion', data: reopened, id: 'suggestion-22' },
    ]);
    const restoredCard = b.getAnnotationElement(file, 'suggestion-21');
    const reopenedCard = b.getAnnotationElement(file, 'suggestion-22');
    const state = (card) => ({ collapsed: card.classList.contains('collapsed'), adoption: card.dataset.hiddenForAdoption ?? null });
    const built = { restored: state(restoredCard), reopened: state(reopenedCard) };

    // The reader shows the adopted suggestion again (what restoreSuggestion
    // does to the card), and the flow records the card as showing its status.
    reopenedCard.classList.remove('collapsed');
    suggestionManager.markSuggestionSynced(reopenedCard, reopened);

    // The adopting comment of the other suggestion is restored: data only,
    // and its card annotation is added on the suggestion's own line.
    const comment = { id: 31, file, line_start: line, line_end: line, side: 'RIGHT', body: 'adopted text', parent_id: 21, status: 'active' };
    pageState.userComments.push(comment);
    b.addAnnotation(file, { lineNumber: line, side: 'RIGHT', type: 'comment', data: comment, id: 'comment-31' });
    await H.settle(100);
    const afterRestore = { restored: state(restoredCard), reopened: state(reopenedCard) };

    // Away and back: a remount, which draws every annotation of the file again.
    b.scrollToItem(far);
    await H.settle(300);
    b.scrollToItem(file);
    await H.settle(300);
    return {
      built,
      afterRestore,
      afterRemount: { restored: state(restoredCard), reopened: state(reopenedCard) },
      sameCards: b.getAnnotationElement(file, 'suggestion-21') === restoredCard && b.getAnnotationElement(file, 'suggestion-22') === reopenedCard,
      connected: restoredCard.isConnected && reopenedCard.isConnected,
    };
  }, { file, line, far });
  expect(result.built).toEqual({
    restored: { collapsed: true, adoption: null },
    reopened: { collapsed: true, adoption: 'true' },
  });
  // Adding the restored comment on the suggestion's line draws no other card
  // again: the suggestion keeps showing "dismissed", as on the current engine.
  expect(result.afterRestore).toEqual({
    restored: { collapsed: true, adoption: null },
    reopened: { collapsed: false, adoption: 'true' },
  });
  // The remount is a draw: the restored suggestion now shows "adopted"; the
  // one the reader re-opened is still open.
  expect(result.afterRemount).toEqual({
    restored: { collapsed: true, adoption: 'true' },
    reopened: { collapsed: false, adoption: 'true' },
  });
  expect(result.sameCards).toBe(true);
  expect(result.connected).toBe(true);
});
