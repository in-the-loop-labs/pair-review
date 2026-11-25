// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The diff pane as E2E specs see it: the half of tests/e2e/diff-dom.js that
 * knows the virtualized viewer (`CodeView`) from the inside.
 *
 * diff-dom.js loads it and exports its helpers under the names specs use, so
 * no spec imports this file. Like diff-dom.js it may name vendor DOM;
 * `tests/unit/e2e-vendor-dom-boundary.test.js` allows the two files and no
 * other. (Two files because one would be over the repository's size
 * guideline.)
 *
 * What is here:
 *  - One viewer draws every file of the pane, changed files and context
 *    files, and mounts only the files near the viewport. A file's element
 *    (`diffs-container.d2h-file-wrapper[data-file-name]`, the vendor host
 *    itself) exists only while the file is mounted. "Which files are in the
 *    pane, in which order" is therefore read from the bridge's records, and
 *    a helper that reads a file's rows brings the file into view first.
 *  - A context file is an item like a changed file: rows and separators are
 *    in its host's shadow root, its hidden gaps are the vendor's separators
 *    ("N unmodified lines") with the vendor's expand controls.
 *  - The bridge's record of a file (`_instance`, `metadata`, `upgraded`,
 *    `kind`), and whether what is on screen is what the bridge asked for.
 */

const { expect } = require('@playwright/test');

/**
 * Extends the in-page library of diff-dom.js (`window.__diffDom`) for this
 * engine. Runs in the page, after diff-dom.js's own installer.
 */
/* eslint-disable no-undef */
function extendInPage() {
  const D = window.__diffDom;
  if (!D || D.engine === 'codeview') return;
  D.engine = 'codeview';

  const bridge = () => (window.prManager && window.prManager.pierreBridge) || null;

  /**
   * The viewer holds a navigation's scroll target until the reader takes
   * over: a wheel, a key, a pointer press on the pane. A position written by
   * a script is not one of those and is undone by the target (measured: the
   * pane back at 22,988 px ten seconds after a test set it to 0, following a
   * sidebar jump). A test that scrolls stands for a reader who scrolls, so it
   * lets go the way a wheel does before it writes the position.
   */
  D.releaseScroll = () => {
    const root = document.getElementById('diff-container');
    if (root) root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 0 }));
  };

  /** D.watchScrollRequests on this engine: a scroll target given to the viewer is a request too. */
  D.watchViewerScrollRequests = (log) => {
    const viewer = bridge() && bridge().codeView;
    if (!viewer || viewer.scrollToWatchedBy === log) return;
    const original = viewer.scrollToUnwatched || viewer.scrollTo.bind(viewer);
    viewer.scrollToUnwatched = original;
    viewer.scrollToWatchedBy = log;
    viewer.scrollTo = (target) => {
      log.push(target && target.id != null ? target.id : null);
      return original(target);
    };
  };

  /** The bridge's record of a file of the pane (changed or context), or null. */
  D.record = (file) => {
    const b = bridge();
    return (b && b.files && b.files.get(file)) || null;
  };

  /** Nothing is mounted until the highlight pool is ready or has failed; after that the engine re-creates nothing by itself. */
  D.engineSettled = () => {
    const b = bridge();
    if (!b) return false;
    const pool = b.workerManager;
    if (!pool || typeof pool.getStats !== 'function') return true;
    const stats = pool.getStats() || {};
    return !!stats.workersFailed || stats.managerState === 'initialized' || /fail|error/i.test(stats.managerState || '');
  };

  /**
   * True when what is on screen for `file` is the diff the bridge last
   * published for it. A file that is collapsed or not mounted displays no
   * rows, so there is nothing to wait for.
   */
  D.isDisplayCurrent = (file) => {
    if (!D.engineSettled()) return false;
    const b = bridge();
    const record = D.record(file);
    if (!record || record.collapsed) return true;
    if (!b.findFileElement(file)) return true;
    return b.isDiffDisplayed(file);
  };

  D.contentsTaken = (file) => {
    const record = D.record(file);
    return !!(record && record.kind === 'diff' && record.upgraded);
  };

  // D.dump: the cards under a file's lines. The file-comment zone and a
  // file's notice are slotted under "line 0" of the item; they are not line
  // cards (the per-file renderer the dumps were first taken on had them
  // beside the diff body), and the notice is reported as a notice.
  const dumpAsDrawn = D.dump;
  D.dump = (file) => {
    const out = dumpAsDrawn(file);
    if (!out) return out;
    out.annotations = out.annotations
      .map((slot) => ({ ...slot, cards: slot.cards.filter((card) => !/(^| )(file-comments-zone|large-diff-placeholder)( |$)/.test(card.classes)) }))
      .filter((slot) => slot.cards.length > 0);
    // A file without a line (binary, mode change, empty, pure rename) is an
    // item with an empty code block here and had no code block at all on the
    // per-file renderer. A reader sees the header either way: no layout to name.
    if (out.columns.every((column) => column.rows.length === 0) && out.separators.length === 0) {
      out.diffType = null;
      out.columns = [];
    }
    return out;
  };

  /** The files of the pane, in pane order, from the bridge's records. */
  D.paneFiles = () => {
    const b = bridge();
    if (!b || !b.files) return [];
    return [...b.files.values()].map((record, index) => {
      const host = b.findFileElement(record.id);
      return { file: record.id, kind: record.kind, top: host ? host.getBoundingClientRect().top : null, index };
    });
  };

  /** The space the viewer keeps between two files of the pane, in px (its layout's gap; the files' elements have no margin). */
  D.viewerGap = () => {
    const gap = bridge()?.codeView?.options?.layout?.gap;
    return typeof gap === 'number' ? gap : 0;
  };

  /** Hosts in the DOM against the items the viewer says it has rendered. */
  D.hostAccounting = () => {
    const b = bridge();
    const root = document.getElementById('diff-container');
    const hosts = root ? [...root.querySelectorAll('diffs-container')] : [];
    const rendered = b && b.codeView && typeof b.codeView.getRenderedItems === 'function'
      ? b.codeView.getRenderedItems().length
      : null;
    const names = hosts.map((h) => h.getAttribute('data-file-name'));
    const duplicates = names.filter((name, i) => name != null && names.indexOf(name) !== i);
    return { hosts: hosts.length, rendered, unnamed: names.filter((n) => n == null).length, duplicates };
  };

  // ---- flashes ---------------------------------------------------------

  D.flashedLines = (file) => {
    const w = D.wrapper(file) || D.contextWrapper(file);
    const root = w && w.shadowRoot;
    if (!root) return [];
    return [...root.querySelectorAll('[data-content] > [data-line].pierre-line-highlight')]
      .map((row) => Number(row.getAttribute('data-line')));
  };

  // ---- context files -----------------------------------------------------
  // A context file is an item of the viewer. Its lines are rows of its
  // host's shadow root; a hidden gap of more than five lines is a vendor
  // separator with expand controls; a smaller one is drawn in full.

  D.contextRoot = (file) => {
    const w = D.contextWrapper(file);
    return (w && w.shadowRoot) || null;
  };

  /** Line rows of a context file that are in the DOM, in order. */
  D.contextLineRows = (file) => {
    const root = D.contextRoot(file);
    return root ? [...root.querySelectorAll('[data-content] > [data-line]')] : [];
  };

  D.contextLineRow = (file, line) => D.contextLineRows(file)
    .find((row) => Number(row.getAttribute('data-line')) === Number(line)) || null;

  /** Separators of a context file that stand for hidden lines, in order (the gutter column holds the controls). */
  D.contextGapRows = (file) => {
    const root = D.contextRoot(file);
    return root ? [...root.querySelectorAll('[data-gutter] > [data-separator][data-expand-index]')] : [];
  };

  /**
   * The line numbers a context file shows, from the bridge's visibility
   * oracle. The viewer keeps only a window of a long item's rows in the DOM,
   * so the rows there are checked against this, not the other way round.
   */
  D.contextShownLines = (file) => {
    const b = bridge();
    const record = D.record(file);
    if (!b || !record || record.kind !== 'context') return [];
    const total = (record.baseMetadata && record.baseMetadata.additionLines && record.baseMetadata.additionLines.length) || 0;
    const lines = [];
    // isLineVisible answers false for a collapsed file; the lines a file
    // shows when expanded are what a range is.
    const wasCollapsed = record.collapsed;
    record.collapsed = false;
    try {
      for (let n = 1; n <= total; n++) if (b.isLineVisible(file, n, 'RIGHT')) lines.push(n);
    } finally {
      record.collapsed = wasCollapsed;
    }
    return lines;
  };

  const toRanges = (lines) => {
    const ranges = [];
    for (const n of lines) {
      const last = ranges[ranges.length - 1];
      if (last && n === last.end + 1) last.end = n;
      else ranges.push({ start: n, end: n });
    }
    return ranges;
  };

  const totalLinesOf = (record) => (record && record.baseMetadata && record.baseMetadata.additionLines
    && record.baseMetadata.additionLines.length) || 0;

  /**
   * The hidden gaps of a context file, top to bottom, from data: the runs of
   * lines the file does not show. `directions` is what the viewer offers for
   * a gap of that size in that place, in the application's words: 'up'
   * reveals lines above the range that follows the gap, 'down' lines below
   * the range before it, 'both' the whole of a small gap between two ranges.
   */
  D.contextGaps = (file) => {
    const record = D.record(file);
    const total = totalLinesOf(record);
    const ranges = toRanges(D.contextShownLines(file));
    const gaps = [];
    let previous = 0;
    for (const range of ranges) {
      if (range.start - previous > 1) gaps.push({ start: previous + 1, end: range.start - 1 });
      previous = range.end;
    }
    if (total - previous > 0) gaps.push({ start: previous + 1, end: total });
    return gaps.map((gap) => {
      const hidden = gap.end - gap.start + 1;
      const position = gap.start === 1 ? 'start' : gap.end === total ? 'end' : 'between';
      const directions = position === 'start' ? ['up']
        : position === 'end' ? ['down']
          : hidden > 20 ? ['down', 'up'] : ['both'];
      return { ...gap, hidden, position, directions, hasExpandAll: hidden > 20 };
    });
  };

  /**
   * The separators of a context file that are in the DOM, each with the gap
   * (of D.contextGaps) it stands for. A separator's place is read from the
   * rows next to it; one whose neighbours are both outside the viewer's row
   * window cannot be placed and is left out.
   */
  D.contextSeparators = (file) => {
    const root = D.contextRoot(file);
    const content = root && root.querySelector('code [data-content]');
    if (!content) return [];
    const gaps = D.contextGaps(file);
    const gutterByIndex = new Map(D.contextGapRows(file).map((el) => [el.getAttribute('data-expand-index'), el]));
    const children = [...content.children];
    const out = [];
    let lastLine = null;
    children.forEach((el, at) => {
      if (el.hasAttribute('data-line')) {
        lastLine = Number(el.getAttribute('data-line'));
        return;
      }
      if (!el.hasAttribute('data-separator') || !el.hasAttribute('data-expand-index')) return;
      const expandIndex = el.getAttribute('data-expand-index');
      const gutter = gutterByIndex.get(expandIndex);
      if (!gutter) return;
      const next = children.slice(at + 1).find((other) => other.hasAttribute('data-line'));
      const nextLine = next ? Number(next.getAttribute('data-line')) : null;
      const gapIndex = gaps.findIndex((gap) => (lastLine != null ? gap.start === lastLine + 1
        : nextLine != null ? gap.end === nextLine - 1
          : gaps.length === 1));
      if (gapIndex < 0) return;
      const labelEl = gutter.querySelector('[data-unmodified-lines]') || el.querySelector('[data-unmodified-lines]');
      const label = labelEl ? labelEl.textContent.replace(/\s+/g, ' ').trim() : '';
      const match = /(\d+) unmodified lines?/.exec(label);
      const directions = [];
      if (gutter.querySelector('[data-expand-up]')) directions.push('down');
      if (gutter.querySelector('[data-expand-down]')) directions.push('up');
      if (gutter.querySelector('[data-expand-both]')) directions.push('both');
      out.push({
        gapIndex,
        expandIndex,
        label,
        hidden: match ? Number(match[1]) : null,
        directions,
        hasExpandAll: !!gutter.querySelector('[data-expand-all-button]'),
        contentEl: el,
      });
    });
    return out;
  };

  /** What a reader sees of a context file, as data. Null when the file is not mounted. */
  D.contextDump = (file) => {
    const w = D.contextWrapper(file);
    const record = D.record(file);
    if (!w || !record) return null;
    const root = w.shadowRoot;
    const header = w.querySelector('.d2h-file-header');
    const lines = D.contextShownLines(file);
    const ranges = toRanges(lines);
    const gaps = D.contextGaps(file);
    const separators = D.contextSeparators(file);

    // What is drawn must agree with the data wherever it is drawn. The
    // viewer keeps a window of a long item's rows in the DOM, so the DOM can
    // hold less than the data says, never something else.
    for (const separator of separators) {
      const gap = gaps[separator.gapIndex];
      const single = (list) => (list.length === 1 && list[0] === 'both'
        ? [gap.position === 'start' ? 'up' : gap.position === 'end' ? 'down' : 'both'] : list);
      const drawn = single(separator.directions).slice().sort().join(',');
      const expected = gap.directions.slice().sort().join(',');
      if (separator.hidden !== gap.hidden || drawn !== expected || separator.hasExpandAll !== gap.hasExpandAll) {
        throw new Error(`context file ${file}: the separator for lines ${gap.start}-${gap.end} is drawn as `
          + `${JSON.stringify({ hidden: separator.hidden, directions: separator.directions, expandAll: separator.hasExpandAll })}, `
          + `the data says ${JSON.stringify({ hidden: gap.hidden, directions: gap.directions, expandAll: gap.hasExpandAll })}`);
      }
      gap.label = separator.label;
    }

    // The DOM, top to bottom: rows, separators and the cards under a line.
    const sequence = [];
    const domLines = [];
    const content = root && root.querySelector('code [data-content]');
    for (const el of content ? [...content.children] : []) {
      if (el.hasAttribute('data-line')) {
        const line = Number(el.getAttribute('data-line'));
        domLines.push(line);
        sequence.push({ kind: 'line', line, text: el.textContent });
      } else if (el.hasAttribute('data-separator')) {
        const separator = separators.find((entry) => entry.contentEl === el);
        if (separator) sequence.push({ kind: 'gap', hidden: separator.hidden, label: separator.label });
      } else if (el.hasAttribute('data-line-annotation')) {
        const slot = el.querySelector('slot');
        const name = slot && slot.getAttribute('name');
        const slotted = name ? w.querySelector(`:scope > [data-annotation-slot][slot="${name}"]`) : null;
        for (const child of slotted ? [...slotted.children] : []) {
          const card = child.matches('.user-comment-row, .ai-suggestion-row, .ai-suggestion, .user-comment-form') ? child
            : child.querySelector('.user-comment-row, .ai-suggestion, .user-comment-form');
          if (!card) continue;
          sequence.push({
            kind: 'card',
            classes: [...card.classList].sort().join(' '),
            commentId: card.getAttribute('data-comment-id') || (card.querySelector('[data-comment-id]') || {}).dataset?.commentId || null,
            suggestionId: card.getAttribute('data-suggestion-id') || (card.querySelector('[data-suggestion-id]') || {}).dataset?.suggestionId || null,
          });
        }
      }
    }
    const stray = record.collapsed ? [] : domLines.filter((n) => !lines.includes(n));
    if (stray.length > 0) {
      throw new Error(`context file ${file}: lines ${stray.join(',')} are drawn but the bridge says they are hidden`);
    }

    return {
      file,
      collapsed: w.classList.contains('collapsed'),
      bodyVisible: D.contextLineRows(file).some((row) => row.getClientRects().length > 0),
      header: header ? {
        name: (header.querySelector('.d2h-file-name') || {}).textContent || null,
        badge: ((header.querySelector('.context-badge') || {}).textContent || '').trim(),
        viewed: !!(header.querySelector('.file-viewed-checkbox') || {}).checked,
        hasCommentButton: !!header.querySelector('.file-header-comment-btn'),
        hasChatButton: !!header.querySelector('.file-header-chat-btn'),
        hasDismissButton: !!header.querySelector('.context-file-dismiss'),
      } : null,
      totalLines: totalLinesOf(record),
      lines,
      ranges,
      // `label` is the drawn text; null for a gap whose separator is outside the viewer's row window.
      gaps: gaps.map(({ hidden, label, directions }) => ({ kind: 'gap', hidden, label: label == null ? null : label, directions })),
      gapPlaces: gaps.map(({ start, end, hidden, position, hasExpandAll }) => ({ start, end, hidden, position, hasExpandAll })),
      // One separator between two runs of lines, as between two chunks.
      separators: Math.max(0, ranges.length - 1),
      sequence,
    };
  };

  /**
   * D.dump of a changed file with what makes its parts mergeable: the viewer
   * keeps only a window of a long item's rows in the DOM, so a whole file is
   * read window by window. Rows carry their index in the file's layout,
   * separators the gap they stand for.
   */
  D.dumpPart = (file) => {
    const base = D.dump(file);
    const host = D.host(file);
    if (!base || !host) return null;
    const pre = host.shadowRoot && host.shadowRoot.querySelector('pre[data-diff-type]');
    const columns = [];
    const separators = [];
    const controls = [];
    if (pre) {
      for (const code of pre.querySelectorAll('code')) {
        const name = code.hasAttribute('data-additions') ? 'additions'
          : code.hasAttribute('data-deletions') ? 'deletions'
            : code.hasAttribute('data-unified') ? 'unified' : 'unknown';
        const rows = [];
        // The index of the row before a separator places it in the file. In
        // a window that does not start at the file's first row, a separator
        // with no row before it cannot be placed: the window before this
        // one, which overlaps it, has that row. Where the window starts is
        // the viewer's own record of it, not where the file is in the pane:
        // the pane moves by the rows added above the line in view when a
        // file's contents arrive under the reader, and a file's first
        // separator is then a few pixels under the pinned header, not gone.
        const drawnFrom = D.record(file) && D.record(file)._instance && D.record(file)._instance.renderRange;
        const atFileTop = !(drawnFrom && drawnFrom.startingLine > 0);
        let previous = null;
        for (const el of code.querySelectorAll('[data-content] > *')) {
          if (el.hasAttribute('data-line')) {
            const pair = (el.getAttribute('data-line-index') || '').split(',').map(Number);
            const index = name === 'unified' ? pair[0] : pair[1];
            previous = index;
            rows.push({ index, type: el.getAttribute('data-line-type'), line: el.getAttribute('data-line'), alt: el.getAttribute('data-alt-line'), text: el.textContent });
          } else if (el.hasAttribute('data-separator')) {
            if (previous == null && !atFileTop) continue;
            separators.push({ column: name, after: previous == null ? -1 : previous, text: (el.textContent || '').replace(/\s+/g, ' ').trim() });
          }
        }
        columns.push({ name, rows });
        for (const button of code.querySelectorAll('[data-gutter] [data-expand-button]')) {
          const separator = button.closest('[data-separator]');
          controls.push(`${name}:${separator ? separator.getAttribute('data-expand-index') : '?'}:${[...button.attributes].map((a) => a.name).filter((n) => n.startsWith('data-expand')).sort().join('+')}`);
        }
      }
    }
    const scroller = D.scroller().getBoundingClientRect();
    const box = host.getBoundingClientRect();
    return { base, columns, separators, controls, top: box.top - scroller.top, bottom: box.bottom - scroller.top, view: scroller.height };
  };

  /**
   * D.dump of a whole changed file. The viewer keeps only the rows near the
   * viewport in the DOM, so a file taller than the pane is walked from its
   * top to its bottom by real scrolling, most of a pane at a time, and the
   * windows are merged by each row's index in the file's layout. The scroll
   * position is put back afterwards.
   */
  D.dumpWhole = async (file) => {
    const frames = (count) => new Promise((resolve) => {
      const tick = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
      tick(count);
    });
    let part = D.dumpPart(file);
    if (!part) return null;
    const columns = new Map();
    const separators = new Map();
    const controls = new Set();
    const annotations = new Map();
    const take = (p) => {
      for (const column of p.columns) {
        if (!columns.has(column.name)) columns.set(column.name, new Map());
        for (const row of column.rows) columns.get(column.name).set(row.index, row);
      }
      for (const separator of p.separators) separators.set(`${separator.column}|${separator.after}`, separator);
      for (const control of p.controls) controls.add(control);
      for (const slot of p.base.annotations) annotations.set(slot.slot, slot);
    };
    take(part);
    const scroller = D.scroller();
    const start = scroller.scrollTop;
    if (part.bottom - part.top > part.view) {
      scroller.scrollTop += part.top;
      for (let step = 0; step < 5000; step++) {
        await frames(2);
        part = D.dumpPart(file);
        if (!part) break;
        take(part);
        if (part.bottom <= part.view + 1) break;
        const before = scroller.scrollTop;
        scroller.scrollTop = before + Math.max(100, Math.floor(part.view * 0.8));
        if (scroller.scrollTop <= before) break;
      }
      scroller.scrollTop = start;
      await frames(2);
    }
    const result = { ...(D.dump(file) || part.base) };
    if (result.diffType !== null) {
      result.columns = [...columns.entries()].map(([name, rows]) => ({
        name,
        rows: [...rows.values()].sort((a, b) => a.index - b.index).map(({ type, line, alt, text }) => ({ type, line, alt, text })),
      }));
    }
    // As D.dump reports them: every column's separators, column by column.
    result.separators = [...columns.keys()].flatMap((name) => [...separators.values()]
      .filter((entry) => entry.column === name).sort((a, b) => a.after - b.after).map((entry) => entry.text));
    result.expandControls = controls.size;
    result.annotations = [...annotations.values()];
    return result;
  };

  D.contextLayout = (file) => {
    const w = D.contextWrapper(file);
    const pre = w && w.shadowRoot && w.shadowRoot.querySelector('pre[data-diff-type]');
    if (!pre) return null;
    const columns = [...pre.querySelectorAll('code')].filter((code) => code.getClientRects().length > 0);
    const left = Math.min(...columns.map((code) => code.getBoundingClientRect().left));
    const right = Math.max(...columns.map((code) => code.getBoundingClientRect().right));
    return { columns: columns.length, codeWidth: right - left, fileWidth: w.clientWidth };
  };

  /**
   * True for a changed file that is outside the viewer's mounted window once
   * the viewer has drawn its first pass: it has no rows, its contents are
   * not fetched until it is mounted, and nothing about it is going to change
   * by itself.
   */
  D.restsUnmounted = (file) => {
    const b = bridge();
    const record = D.record(file);
    if (!b || !record || !b.codeView || !D.engineSettled()) return false;
    if (b.findFileElement(file)) return false;
    return b.codeView.getRenderedItems().length > 0;
  };

  const upgradedAndDisplayed = (file) => D.contentsTaken(file) && D.isDisplayCurrent(file);
  D.isUpgraded = (file) => upgradedAndDisplayed(file) || D.restsUnmounted(file);
}
/* eslint-enable no-undef */

/**
 * The standing check of every test on this engine: when a test ends, every
 * host in the pane is one the viewer accounts for (vendor fact F1: an item
 * spliced into the list above a mounted one leaves an orphan host behind),
 * every host carries a file, and no file has two. Runs in the page; answers
 * the problems found, none for a page without a viewer.
 * @returns {Promise<string[]>}
 */
/* eslint-disable no-undef */
const orphanHostsOf = (page) => page.evaluate(() => {
  const bridge = window.prManager && window.prManager.pierreBridge;
  const root = document.getElementById('diff-container');
  if (!bridge || !bridge.codeView || !root) return [];
  const hosts = [...root.querySelectorAll('diffs-container')];
  const rendered = bridge.codeView.getRenderedItems().length;
  const names = hosts.map((host) => host.getAttribute('data-file-name'));
  const problems = [];
  if (hosts.length !== rendered) problems.push(`${hosts.length} hosts in the DOM, the viewer has ${rendered} rendered items`);
  const unnamed = names.filter((name) => name == null).length;
  if (unnamed > 0) problems.push(`${unnamed} hosts without a file`);
  const twice = names.filter((name, i) => name != null && names.indexOf(name) !== i);
  if (twice.length > 0) problems.push(`two hosts for ${twice.join(', ')}`);
  return problems;
});
/* eslint-enable no-undef */

/**
 * A development-bundle run (PR_VENDOR_BUNDLE=dev; tests/e2e/fixtures.js): the
 * vendor's development bundle has the viewer's own layout validator compiled
 * in, and with it every test asserts the viewer's layout through the console
 * guard. This is what such a run needs to know of the viewer and the bridge.
 */
const layoutValidator = {
  /**
   * Runs in the page before any of its scripts (an init script): gives the
   * viewer its validator and counts what it reports. Nothing it reports is
   * expected: every report fails the test through the console guard, with
   * one exception that is decided in the frames that follow (see below): a
   * height the viewer had not followed yet when a render was forced, and
   * has followed once the pane's box has stopped changing.
   */
  /* eslint-disable no-undef */
  installInPage: () => {
      const state = { reports: 0, followed: 0 };
      window.__layoutValidator = state;
      const report = console.error;
      console.error = function (...args) {
        const text = typeof args[0] === 'string' ? args[0] : '';
        if (text.startsWith('CodeView: sticky container height does not match computed layout')) {
          // Vendor fact F27 (tests/contract/vendor/layout.spec.js,
          // tests/contract/bridge/view.spec.js): something changed the height
          // of what is drawn (a card or a file's comment zone grew, lines
          // wrapped again because the pane got narrower), and a render was
          // forced before the next frame. The viewer follows the change when
          // the browser reports the resize, which is in that frame and
          // before it is painted. So the report is not decided in its task.
          // The validator's own comparison is made again in the frames that
          // follow: a layout that agrees was never shown wrong, and the
          // report is counted as followed. A layout that still disagrees
          // after two frames in which the pane's box did not change is a
          // real mismatch and fails the test like any other report. A frame
          // in which the box did change does not count towards the two: a
          // panel that opens animates the pane's width for 0.2 s, the lines
          // of every drawn file wrap again in each of those frames, and the
          // viewer follows each one in its own frame (measured: the review
          // panel opening over a drawn 4,000-line file, a render forced in
          // every frame; ledger H139).
          const snapshot = () => {
            const bridge = window.prManager.pierreBridge;
            const viewer = bridge.codeView;
            const actual = viewer.stickyContainer.getBoundingClientRect().height;
            const { firstIndex, lastIndex, stickyHeight } = viewer.renderState;
            // Per drawn file whose box is not what the viewer has for it:
            // the end of its path, the difference, and whether the diff on
            // screen is the one the bridge last published.
            const off = viewer.getRenderedItems().map((item) => {
              const specs = item.instance && item.instance.getAdvancedStickySpecs && item.instance.getAdvancedStickySpecs();
              const height = item.element ? item.element.getBoundingClientRect().height : null;
              if (!specs || height == null || specs.height === height) return null;
              const id = String(item.item && item.item.id);
              return `${id.slice(-14)} ${Math.round((height - specs.height) * 100) / 100}${bridge.isDiffDisplayed(id) ? '' : ' swap'}`;
            }).filter(Boolean);
            const width = document.getElementById('diff-container').getBoundingClientRect().width;
            return {
              // The viewer's own tolerance for this comparison (SUB_PIXEL_TOLERANCE).
              agrees: Math.abs(actual - stickyHeight) < 1,
              box: `${actual}x${width}`,
              text: `${Math.round((actual - stickyHeight) * 100) / 100} items ${firstIndex}-${lastIndex} top ${Math.round(viewer.getScrollTop())}${viewer.pendingScrollTarget != null || viewer.scrollAnimation != null ? ' scrolling' : ''} [${off.join('; ')}]`,
            };
          };
          const MAX_FRAMES = 240;
          let atReport = null;
          try { atReport = snapshot(); } catch (_error) { atReport = null; }
          let box = atReport ? atReport.box : null;
          let frames = 0;
          let atRest = 0;
          const decide = () => {
            let now = null;
            try { now = snapshot(); } catch (_error) { now = null; }
            frames += 1;
            if (now && now.agrees) {
              state.followed += 1;
              return;
            }
            const moved = !!now && box !== null && now.box !== box;
            if (now) box = now.box;
            atRest = moved ? 0 : atRest + 1;
            if (!now || atRest >= 2 || frames >= MAX_FRAMES) {
              state.reports += 1;
              // What the pane was doing, for whoever reads the failure
              // (before the viewer's own object: the console guard keeps the
              // first 300 characters of a line).
              report.apply(console, [args[0], `(then: ${atReport ? atReport.text : '?'}; ${frames} frame(s) later, the pane at rest: ${now ? now.text : '?'})`, ...args.slice(1)]);
              return;
            }
            requestAnimationFrame(decide);
          };
          requestAnimationFrame(decide);
          return undefined;
        }
        if (text.startsWith('CodeView: ') || text.startsWith('VirtualizedFileDiff')) state.reports += 1;
        return report.apply(this, args);
      };

      let Bridge;
      Object.defineProperty(window, 'PierreBridge', {
        configurable: true,
        get() { return Bridge; },
        set(Real) {
          Bridge = class extends Real {
            constructor(options = {}) {
              super({ ...options, viewerOptions: { ...(options.viewerOptions || {}), __devOnlyValidateItemHeights: true } });
            }
          };
        },
      });
  },
  /* eslint-enable no-undef */

  /**
   * For the fixture's own tests: log the viewer's sticky-height report while
   * the viewer's number for the drawn files reads `by` px short, whatever
   * the viewer writes to it meanwhile, and nothing moves. The comparison the
   * fixture repeats stays unequal.
   * @returns {Promise<{sameTask: Object, oneFrame: Object, later: Object}>} the fixture's counters
   */
  /* eslint-disable no-undef */
  reportWithTheLayoutOff: (page, by) => page.evaluate(async (by) => {
    const { renderState } = window.prManager.pierreBridge.codeView;
    let real = renderState.stickyHeight;
    Object.defineProperty(renderState, 'stickyHeight', { configurable: true, enumerable: true, get: () => real - by, set: (value) => { real = value; } });
    try {
      console.error('CodeView: sticky container height does not match computed layout', { delta: by });
      const sameTask = { ...window.__layoutValidator };
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const oneFrame = { ...window.__layoutValidator };
      for (let frames = 0; frames < 3; frames++) await new Promise((resolve) => requestAnimationFrame(resolve));
      return { sameTask, oneFrame, later: { ...window.__layoutValidator } };
    } finally {
      delete renderState.stickyHeight;
      renderState.stickyHeight = real;
    }
  }, by),
  /* eslint-enable no-undef */

  /**
   * For the fixture's own tests: close the review panel, open it again (its
   * width animates) and force a render of the viewer in every frame of it.
   * @returns {Promise<{before: Object, after: Object, widths: number}>} the
   *   fixture's counters before and after, and how many widths the pane had
   */
  /* eslint-disable no-undef */
  openReviewPanelUnderForcedRenders: (page) => page.evaluate(async () => {
    const viewer = window.prManager.pierreBridge.codeView;
    const pane = document.getElementById('diff-container');
    const widths = new Set();
    window.aiPanel.collapse();
    for (let frames = 0; frames < 30; frames++) await new Promise((resolve) => requestAnimationFrame(resolve));
    const before = { ...window.__layoutValidator };
    window.aiPanel.expand();
    for (let frames = 0; frames < 40; frames++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      widths.add(Math.round(pane.getBoundingClientRect().width));
      viewer.render(true);
    }
    for (let frames = 0; frames < 6; frames++) await new Promise((resolve) => requestAnimationFrame(resolve));
    return { before, widths: widths.size, after: { ...window.__layoutValidator } };
  }),
  /* eslint-enable no-undef */

  /**
   * For the fixture's own tests: log the viewer's sticky-height report while
   * the viewer's number for the drawn files reads `by` px short, and change
   * the height of a drawn file between the first and the second frame after
   * it (the comment form of the first file opens). The comparison the
   * fixture repeats is unequal at both frames, and the pane's box is not
   * the same at the second as at the first. From then on the viewer's
   * number is its own again. The form is cancelled before this returns.
   * @returns {Promise<{before: Object, oneFrame: Object, twoFrames: Object, later: Object, grew: number}>}
   *   the fixture's counters at each point, and by how much the drawn files grew
   */
  /* eslint-disable no-undef */
  reportThenChangeHeightBetweenFrames: (page, by) => page.evaluate(async (by) => {
    const viewer = window.prManager.pierreBridge.codeView;
    const { renderState } = viewer;
    const drawn = () => viewer.stickyContainer.getBoundingClientRect().height;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    // A task queued from a frame's callbacks runs when that frame is done and before the next one begins.
    const task = () => new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
      channel.port2.postMessage(null);
    });
    let real = renderState.stickyHeight;
    let short = by;
    Object.defineProperty(renderState, 'stickyHeight', { configurable: true, enumerable: true, get: () => real - short, set: (value) => { real = value; } });
    let form = null;
    try {
      const before = { ...window.__layoutValidator };
      const heightBefore = drawn();
      console.error('CodeView: sticky container height does not match computed layout', { delta: by });
      await frame();
      const oneFrame = { ...window.__layoutValidator };
      await task();
      document.querySelector('#diff-container .file-header-comment-btn').click();
      form = document.querySelector('#diff-container .file-comment-form');
      const grew = drawn() - heightBefore;
      await frame();
      const twoFrames = { ...window.__layoutValidator };
      short = 0;
      for (let frames = 0; frames < 4; frames++) await frame();
      return { before, oneFrame, twoFrames, later: { ...window.__layoutValidator }, grew };
    } finally {
      delete renderState.stickyHeight;
      renderState.stickyHeight = real;
      if (form) form.querySelector('.cancel-btn').click();
      for (let frames = 0; frames < 3; frames++) await frame();
    }
  }, by),
  /* eslint-enable no-undef */

  /**
   * One more validating pass with the pane at rest (a pixel of scroll
   * downward, the way a wheel moves it): how many reports it made. Whatever
   * a test did, the viewer's layout is exact once the pane rests.
   * @returns {Promise<number>}
   */
  /* eslint-disable no-undef */
  reportsAtRest: (page) => page.evaluate(async () => {
        const state = window.__layoutValidator;
        const bridge = window.prManager && window.prManager.pierreBridge;
        const root = document.getElementById('diff-container');
        if (!state || !bridge || !bridge.codeView || !root || root.hidden) return 0;
        const frames = (count) => new Promise((resolve) => {
          const tick = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
          tick(count);
        });
        // Let a navigation or a swap that is in flight end first: until the
        // pane has not moved from one frame to the next and every mounted
        // file shows the diff the bridge last published for it.
        const atRest = () => [...bridge.files.values()].every((record) => (
          record.collapsed || !bridge.findFileElement(record.id) || bridge.isDiffDisplayed(record.id)
        ));
        const deadline = performance.now() + 5000;
        let last = null;
        for (;;) {
          const top = root.scrollTop;
          if ((top === last && atRest()) || performance.now() > deadline) break;
          last = top;
          await frames(1);
        }
        await frames(3);
        const before = state.reports;
        root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 0 }));
        root.scrollTop += 1;
        await frames(4);
        return state.reports - before;
  }),
  /* eslint-enable no-undef */
};

/**
 * The Node side of this engine.
 * @param {Object} base - what diff-dom.js has itself: inPage,
 *   waitInPage, contextFile, fileWrapper, waitForContentUpgrade
 * @returns {Object} functions that replace diff-dom.js's own under the same
 *   names, and the values of the named expectations on this engine
 */
function createCodeViewAdapter(base) {
  const { inPage, waitInPage, contextFile, clickOnce } = base;

  const GAP = '[data-gutter] > [data-separator][data-expand-index]';

  /** Bring a file of the pane into the viewer's mounted window, if it is not there. */
  async function ensureMounted(page, file, { timeout = 10000 } = {}) {
    const mounted = await inPage(page, (D, f) => !!(D.wrapper(f) || D.contextWrapper(f)), file);
    if (mounted) return;
    const known = await inPage(page, (D, f) => !!D.record(f), file);
    if (!known) return;
    await page.evaluate((f) => window.prManager.pierreBridge.scrollToItem(f, { align: 'start', behavior: 'instant' }), file);
    await waitInPage(page, (D, f) => !!(D.wrapper(f) || D.contextWrapper(f)), file, { timeout });
  }

  /** The files of the pane, top to bottom, from data (a file outside the mounted window has no element). */
  async function filesInPane(page) {
    return inPage(page, (D) => D.paneFiles().map(({ file, kind, top }) => ({ file, kind, top })));
  }

  /** What a reader sees of a context file. Null when the pane has no such context file. */
  async function contextFileState(page, file) {
    await ensureMounted(page, file);
    // Rows are replaced when a new diff of the item is displayed; read once
    // what is on screen is what the bridge last published. The wait and the
    // read are one evaluation: between a wait and a separate read another
    // diff of the item can be published (the data moves at once, the rows a
    // worker round trip later), and the read would compare one with the
    // other.
    const handle = await waitInPage(page, (D, f) => {
      if (D.record(f) && D.contextWrapper(f) && !D.isDisplayCurrent(f)) return false;
      return { state: D.contextDump(f) };
    }, file);
    const { state } = await handle.jsonValue();
    await handle.dispose();
    return state;
  }

  /** Locator of the row showing `line` of a context file. */
  function contextLine(page, file, line) {
    return contextFile(page, file).locator(`[data-content] > [data-line="${line}"]`);
  }

  /** How a context file's lines are laid out (see diff-dom.js); the file is brought into view first. */
  async function contextFileLayout(page, file) {
    await ensureMounted(page, file);
    await waitInPage(page, (D, f) => !!D.contextLayout(f), file);
    return inPage(page, (D, f) => D.contextLayout(f), file);
  }

  /** The text of a line of a context file, as drawn. */
  async function contextLineText(page, file, line) {
    await ensureMounted(page, file);
    return contextLine(page, file, line).first().textContent();
  }

  /**
   * Click a control of the Nth gap (0-based, top to bottom, of the gaps the
   * data has) of a context file. The gap's separator is brought into the
   * viewer's row window first.
   */
  async function clickGapControl(page, file, gapIndex, pick) {
    await ensureMounted(page, file);
    // The gap as it was when a click on its control was last attempted.
    let attempted = null;
    const sameGap = (a, b) => !!a && !!b && a.start === b.start && a.end === b.end;
    // Separators are re-created with the item's rows; a click whose target
    // was replaced under it never happened and is made again. A click that
    // Playwright reports as timed out may have been delivered all the same
    // (the report can come from what it waits for after the click, on a
    // busy machine): the gap is then not what it was, and clicking again
    // would reveal a second step.
    //
    // And a click Playwright reports as made may have been sent to nothing:
    // the browser sends no click when the file was drawn between the press
    // and the release (ledger H143, on main too; `clickOnce` in diff-dom.js
    // reads from the page whether a click arrived). The viewer draws a
    // context file once more about 0.13 s after a range was added to it,
    // with nothing changed in it (measured), and a press can meet that draw
    // (the phase-9 verifier, 1 of 400). A click that did not arrive is made
    // again; the gap is as it was, so it is the same click.
    await expect(async () => {
      const found = await inPage(page, (D, a) => {
        const gap = D.contextGaps(a.file)[a.gapIndex];
        if (!gap) return { error: `no gap ${a.gapIndex}` };
        const separator = D.contextSeparators(a.file).find((entry) => entry.gapIndex === a.gapIndex);
        if (!separator) {
          // Outside the row window: go to the line next to the gap.
          const line = gap.position === 'start' ? gap.end + 1 : gap.start - 1;
          window.prManager.pierreBridge.scrollToLine(a.file, line, 'RIGHT', { align: 'center', behavior: 'instant', flash: false });
          return { gap, error: 'the separator is not in the DOM yet' };
        }
        return { expandIndex: separator.expandIndex, gap, hasExpandAll: separator.hasExpandAll };
      }, { file, gapIndex });
      if (attempted && !sameGap(attempted, found.gap)) return;
      if (found.error) throw new Error(`gap ${gapIndex} of ${file}: ${found.error}`);
      const control = contextFile(page, file).locator(`${GAP}[data-expand-index="${found.expandIndex}"]`)
        .locator(pick(found)).first();
      await control.scrollIntoViewIfNeeded({ timeout: 2000 });
      const box = await control.boundingBox();
      if (!box) throw new Error(`gap ${gapIndex} of ${file}: its control is not on screen`);
      attempted = { start: found.gap.start, end: found.gap.end };
      const arrived = await clickOnce(page, control, { position: { x: Math.min(box.width / 2, 12), y: box.height / 2 } });
      if (!arrived) throw new Error(`gap ${gapIndex} of ${file}: the browser sent no click (the file was drawn under the press)`);
    }).toPass({ timeout: 10000 });
  }

  /**
   * Click an expand control of the Nth gap (0-based, top to bottom) of a
   * context file. 'up' reveals lines above the range that follows the gap,
   * 'down' lines below the range before it; the vendor names its chevrons
   * by the end of the gap they reveal, which is the other way round.
   */
  async function expandContextGap(page, file, gapIndex, direction) {
    const state = await contextFileState(page, file);
    const gap = state && state.gaps[gapIndex];
    if (!gap || !gap.directions.includes(direction)) {
      throw new Error(`expandContextGap: gap ${gapIndex} of ${file} offers ${JSON.stringify(gap && gap.directions)}, not "${direction}"`);
    }
    const selector = direction === 'down' ? '[data-expand-up], [data-expand-both]' : '[data-expand-down], [data-expand-both]';
    await clickGapControl(page, file, gapIndex, () => selector);
  }

  /** Reveal everything hidden in the Nth gap: "Expand all", or the gap's one control when it has 20 lines or fewer. */
  async function expandContextGapFully(page, file, gapIndex) {
    await clickGapControl(page, file, gapIndex,
      (found) => (found.hasExpandAll ? '[data-expand-all-button]' : '[data-expand-button]'));
  }

  /** The pane has this context file, exactly once; where it is mounted it is visible. */
  async function expectContextFile(page, file) {
    await expect.poll(() => inPage(page, (D, f) => D.paneFiles().filter((e) => e.file === f).map((e) => e.kind), file))
      .toEqual(['context']);
    const hosts = contextFile(page, file);
    expect(await hosts.count()).toBeLessThanOrEqual(1);
    if (await hosts.count() === 1) await expect(hosts).toBeVisible();
  }

  /** The pane has no such context file: neither in its data nor on screen. */
  async function expectNoContextFile(page, file) {
    await expect.poll(() => inPage(page, (D, f) => D.paneFiles().filter((e) => e.file === f && e.kind === 'context').length, file))
      .toBe(0);
    await expect(contextFile(page, file)).toHaveCount(0);
  }

  /** Point at a context line's number and click the comment button of the gutter; waits for the form. */
  async function openContextLineCommentForm(page, file, line) {
    await ensureMounted(page, file);
    const scope = contextFile(page, file);
    const cell = scope.locator(`[data-column-number="${line}"]`).first();
    const forms = page.locator('.user-comment-form');
    const before = await forms.count();
    await expect(async () => {
      await page.mouse.move(0, 0);
      await cell.scrollIntoViewIfNeeded({ timeout: 2000 });
      await cell.hover({ timeout: 2000 });
      // Seen, then clicked (see openLineCommentForm in diff-dom.js).
      await expect(scope.locator('.pierre-comment-btn').first()).toBeVisible({ timeout: 2000 });
      await scope.locator('.pierre-comment-btn').first().click({ timeout: 2000 });
      // The click opened a form, or the gesture is made again (see openLineCommentForm).
      await expect(forms).toHaveCount(before + 1, { timeout: 2000 });
    }).toPass({ timeout: 20000 });
    await expect(forms).toHaveCount(before + 1);
    await scope.locator('.user-comment-form').first().waitFor({ state: 'visible', timeout: 5000 });
  }

  /** Locator of the gutter's "chat about this line" control of a context file (shown for the hovered line). */
  function contextLineChatButton(page, file) {
    return contextFile(page, file).locator('.pierre-chat-btn').first();
  }

  /**
   * Every host in the DOM is one the viewer accounts for (vendor fact F1: an
   * item spliced into the list above a mounted one leaves an orphan), every
   * host carries a file, and no file has two.
   */
  async function assertNoOrphanHosts(page) {
    const state = await inPage(page, (D) => D.hostAccounting());
    const problems = [];
    if (state.rendered != null && state.hosts !== state.rendered) {
      problems.push(`${state.hosts} hosts in the DOM, the viewer has ${state.rendered} rendered items`);
    }
    if (state.unnamed > 0) problems.push(`${state.unnamed} hosts without a file`);
    if (state.duplicates.length > 0) problems.push(`two hosts for ${state.duplicates.join(', ')}`);
    if (problems.length > 0) throw new Error(`Orphan or duplicate diff hosts: ${problems.join('; ')}`);
  }

  /**
   * Everything visible of one changed file, as data (D.dump's shape). A file
   * taller than the pane is read window by window, by real scrolling in the
   * page (D.dumpWhole). Null when the file is not mounted.
   */
  async function dumpFile(page, file) {
    return inPage(page, (D, f) => D.dumpWhole(f), file);
  }

  /**
   * Whether this page checks the viewer's layout as it draws: the vendor's
   * development bundle is what was loaded, and the viewer was given its
   * height validator. (PR_VENDOR_BUNDLE=dev; tests/e2e/fixtures.js.)
   * @returns {Promise<{developmentBundle: boolean, validator: boolean}>}
   */
  async function layoutValidatorState(page) {
    return page.evaluate(async () => {
      const source = await (await fetch('/js/vendor/pierre-diffs.js')).text();
      const bridge = window.prManager && window.prManager.pierreBridge;
      return {
        // The shipped bundle is minified; the development one is not, and
        // names the option.
        developmentBundle: source.includes('__devOnlyValidateItemHeights') && source.split('\n').length > 10000,
        validator: !!(bridge && bridge._viewerOptions && bridge._viewerOptions.__devOnlyValidateItemHeights === true),
      };
    });
  }

  /** The hunk of `file` whose new-side range contains `line`, from the metadata the bridge last published. */
  async function hunkContaining(page, file, line) {
    return inPage(page, (D, a) => {
      const record = D.record(a.file);
      const metadata = record && record.metadata;
      if (!metadata) return null;
      const index = metadata.hunks.findIndex((h) => h.additionStart <= a.line && h.additionStart + h.additionCount > a.line);
      if (index < 0) return null;
      const hunk = metadata.hunks[index];
      return { index, additionStart: hunk.additionStart, additionCount: hunk.additionCount };
    }, { file, line });
  }

  /**
   * Expand hidden lines next to a hunk by an exact number of lines, through
   * the viewer's own instance of the file (what its expand control calls).
   * The file must show its upgraded diff: the control does not exist before.
   */
  async function expandHunkBy(page, file, { hunkIndex, direction, lines }) {
    await ensureMounted(page, file);
    await base.waitForContentUpgrade(page, file);
    await inPage(page, (D, a) => {
      const record = D.record(a.file);
      const instance = record && record._instance;
      if (!instance || !window.prManager.pierreBridge.findFileElement(a.file)) {
        throw new Error(`expandHunkBy: ${a.file} is not mounted`);
      }
      instance.expandHunk(a.hunkIndex, a.direction, a.lines);
    }, { file, hunkIndex, direction, lines });
  }

  /**
   * Put the file's upgraded base diff back on screen while the bridge's
   * record of revealed ranges and its annotations stay: what is drawn (and
   * what the visibility oracle answers from) falls behind what was revealed.
   */
  async function redisplayBaseDiff(page, file) {
    await waitInPage(page, (D) => D.engineSettled(), null, { timeout: 20000 });
    await inPage(page, (D, f) => {
      const bridge = window.prManager.pierreBridge;
      const record = D.record(f);
      if (!record || !record.upgraded || !record.baseMetadata) throw new Error(`redisplayBaseDiff: ${f} is not upgraded`);
      // A new key: the viewer never displays derived metadata under a key it has seen.
      record.metadata = bridge.constructor.rekey(record, record.baseMetadata);
      bridge._retireExpansions(record);
      bridge._publish(record.id);
    }, file);
  }

  /**
   * Draw `file` again as it is, now: the bridge publishes the item, and the
   * viewer takes the file's header, comment zone and cards out of the
   * document and puts them back (every draw does).
   */
  async function redrawFile(page, file) {
    await inPage(page, (D, f) => {
      const record = D.record(f);
      if (!record || !record._element) throw new Error(`redrawFile: ${f} is not mounted`);
      window.prManager.pierreBridge._publish(record.id);
    }, file);
  }

  return {
    overrides: {
      filesInPane,
      contextFileState,
      contextLine,
      contextLineText,
      contextFileLayout,
      expandContextGap,
      expandContextGapFully,
      openContextLineCommentForm,
      contextLineChatButton,
      expectContextFile,
      expectNoContextFile,
      assertNoOrphanHosts,
      dumpFile,
      layoutValidatorState,
      hunkContaining,
      ensureMounted,
      expandHunkBy,
      redisplayBaseDiff,
      redrawFile,
    },
  };
}

module.exports = { extendInPage, createCodeViewAdapter, layoutValidator, orphanHostsOf };
