// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The diff pane, as E2E specs see it.
 *
 * THIS IS THE ONLY E2E FILE THAT KNOWS VENDOR DOM. A spec never names
 * `diffs-container`, a shadow root, `.pierre-diff-body`, or a vendor row
 * attribute (`data-line`, `data-column-number`, `data-separator`,
 * `data-expand-*`, `data-additions`, `data-diff-type`,
 * `data-annotation-slot`, ...), and never reaches for a vendor instance
 * through `prManager.pierreBridge`. It asks this module.
 * `tests/unit/e2e-vendor-dom-boundary.test.js` enforces that.
 *
 * Why: the diff is being moved from one `FileDiff` per file to a single
 * virtualized `CodeView` (plans/codeview-virtualized-diff.md). Every scenario
 * must run unchanged on both engines so that "same spec, two engines" is the
 * proof of parity. When the engine changes, this file changes and the specs
 * do not.
 *
 * What a spec may still name, because the application owns it on both
 * engines: `.d2h-file-wrapper[data-file-name]` (the element that carries a
 * file's identity; its header, file-comment zone and cards are light-DOM
 * descendants), `.d2h-file-header`, card classes (`.user-comment-row`,
 * `.ai-suggestion`, ...), `.pierre-gutter-buttons` / `.pierre-comment-btn` /
 * `.pierre-chat-btn` (application elements), and `#diff-container`.
 *
 * Engine notes (current engine: FileDiff):
 *  - A diff file is `div.d2h-file-wrapper[data-file-name] > .pierre-diff-body
 *    > diffs-container` with an open shadow root. Under CodeView the wrapper
 *    IS the `diffs-container`. `hostOf` below accepts both.
 *  - A context file is `div.d2h-file-wrapper.context-file[data-file-name]`
 *    rendered by the application's table renderer (no shadow DOM).
 *  - Playwright CSS locators pierce open shadow roots, so
 *    `wrapper.locator('[data-line]')` reaches rows in either layout.
 *
 * Timing rules that hold on both engines (tests/CONVENTIONS.md):
 *  - A file's contents are fetched after its patch renders and the diff is
 *    upgraded with them. Rows are re-created by that upgrade. Wait for
 *    `waitForContentUpgrade` before measuring geometry or holding a row.
 *  - CSS transitions are ON. Poll for a settled value; never read once.
 */

// ---------------------------------------------------------------------------
// Selectors (vendor attribute names live here and nowhere else in tests/e2e)
// ---------------------------------------------------------------------------

const { expect } = require('@playwright/test');

const ROW = '[data-line]';
const NUMBER_CELL = '[data-column-number]';
const SEPARATOR = '[data-separator]';
const EXPAND_ANY = '[data-expand-button]';
const EXPAND = {
  up: '[data-expand-up]',
  down: '[data-expand-down]',
  both: '[data-expand-both]',
  any: EXPAND_ANY,
};
const ANNOTATION_SLOT = '[data-annotation-slot]';
const LINE_TYPE = {
  addition: ['change-addition'],
  deletion: ['change-deletion'],
  context: ['context'],
  expanded: ['context-expanded'],
  anyContext: ['context', 'context-expanded'],
};
const COLUMN = {
  additions: 'code[data-additions]',
  deletions: 'code[data-deletions]',
  unified: 'code[data-unified]',
};

/** A CSS attribute-selector value for any string (paths may contain `"`). */
const cssString = (value) => JSON.stringify(String(value));

/** Selector of the element carrying a DIFF file's identity (not a context file). */
function fileSelector(file) {
  return `.d2h-file-wrapper:not(.context-file)[data-file-name=${cssString(file)}]`;
}

/** Selector of a CONTEXT file's wrapper. */
function contextFileSelector(file) {
  return `.d2h-file-wrapper.context-file[data-file-name=${cssString(file)}]`;
}

function sideColumn(side) {
  if (side === 'deletions' || side === 'LEFT') return 'deletions';
  if (side === 'additions' || side === 'RIGHT') return 'additions';
  return null;
}

// ---------------------------------------------------------------------------
// In-page library. Installed on demand; idempotent; survives until the next
// navigation, after which the next helper call installs it again.
// ---------------------------------------------------------------------------

/* eslint-disable no-undef */
function installInPage() {
  if (window.__diffDom) return;
  const D = {};
  const HOST = 'diffs-container';

  D.wrappers = () => [...document.querySelectorAll('#diff-container .d2h-file-wrapper[data-file-name]')];
  D.wrapper = (file) => D.wrappers()
    .find((w) => w.dataset.fileName === file && !w.classList.contains('context-file')) || null;
  D.contextWrapper = (file) => D.wrappers()
    .find((w) => w.dataset.fileName === file && w.classList.contains('context-file')) || null;
  D.hostOf = (wrapper) => {
    if (!wrapper) return null;
    return wrapper.matches(HOST) ? wrapper : wrapper.querySelector(HOST);
  };
  D.host = (file) => D.hostOf(D.wrapper(file));
  D.root = (file) => {
    const host = D.host(file);
    return (host && host.shadowRoot) || null;
  };
  D.hosts = () => [...document.querySelectorAll(`#diff-container ${HOST}`)];
  D.pre = (file) => {
    const root = D.root(file);
    return (root && root.querySelector('pre[data-diff-type]')) || null;
  };
  D.rows = (file) => {
    const root = D.root(file);
    return root ? [...root.querySelectorAll('[data-line]')] : [];
  };
  D.anyRowRendered = () => D.hosts().some((h) => h.shadowRoot && h.shadowRoot.querySelector('[data-line]'));

  /** The element whose scrollTop moves the diff: the nearest scrollable ancestor-or-self of #diff-container. */
  D.scroller = () => {
    let el = document.getElementById('diff-container');
    while (el && el !== document.documentElement) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  };

  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  D.box = box;

  D.diffType = (file) => {
    const pre = D.pre(file);
    return pre ? pre.getAttribute('data-diff-type') : null;
  };

  /** Layout of one file: diff type, the code columns and their gutters. */
  D.layout = (file) => {
    const pre = D.pre(file);
    if (!pre) return null;
    const additions = pre.querySelector('code[data-additions]');
    const deletions = pre.querySelector('code[data-deletions]');
    const unified = pre.querySelector('code[data-unified]');
    const preBox = box(pre);
    return {
      diffType: pre.getAttribute('data-diff-type'),
      pre: { ...preBox, mid: preBox.left + preBox.width / 2 },
      hasAdditions: !!additions,
      hasDeletions: !!deletions,
      hasUnified: !!unified,
      additions: box(additions),
      deletions: box(deletions),
      unified: box(unified),
      addGutter: box(additions && additions.querySelector('[data-gutter]')),
      delGutter: box(deletions && deletions.querySelector('[data-gutter]')),
      // First line-number cell and first content track of the additions column.
      additionsNumberCell: box(additions && additions.querySelector('[data-column-number]')),
      additionsContent: box(additions && additions.querySelector('[data-content]')),
      // Stamped by the application's split-layout sync.
      gutterVar: pre.style.getPropertyValue('--pr-split-gutter-width'),
    };
  };

  /**
   * The vendor cell an annotation card is slotted into, found by the card's
   * text. `column` is the code column that cell sits in.
   */
  D.annotationCell = (file, text) => {
    const host = D.host(file);
    const pre = D.pre(file);
    if (!host || !pre) return null;
    const wrapper = [...host.querySelectorAll('[data-annotation-slot]')]
      .find((w) => (w.textContent || '').includes(text));
    const slot = wrapper && wrapper.assignedSlot;
    const cell = slot && slot.closest('[data-line-annotation]');
    if (!cell) return null;
    const code = cell.closest('code');
    const column = !code ? null
      : code.hasAttribute('data-additions') ? 'additions'
        : code.hasAttribute('data-deletions') ? 'deletions'
          : code.hasAttribute('data-unified') ? 'unified' : null;
    return {
      column,
      slot: wrapper.getAttribute('slot'),
      hasFullwidthClass: cell.classList.contains('pr-annotation-fullwidth'),
      cellWidth: cell.getBoundingClientRect().width,
      preWidth: pre.getBoundingClientRect().width,
      diffType: pre.getAttribute('data-diff-type'),
      gutterVar: pre.style.getPropertyValue('--pr-split-gutter-width'),
    };
  };

  /** The code column ('additions' | 'deletions' | 'unified') a card is slotted into, by card text. */
  D.annotationColumn = (text, selector) => {
    const rows = document.querySelectorAll(selector);
    const row = [...rows].find((r) => (r.textContent || '').includes(text));
    if (!row) return null;
    const wrapper = row.closest('[data-annotation-slot]') || row.parentElement;
    const slot = wrapper && wrapper.assignedSlot;
    const code = slot && slot.closest('code');
    if (!code) return null;
    return code.hasAttribute('data-additions') ? 'additions'
      : code.hasAttribute('data-deletions') ? 'deletions'
        : code.hasAttribute('data-unified') ? 'unified' : null;
  };

  /** Deepest element at a viewport point, descending through open shadow roots. */
  D.elementFromPointDeep = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  /** Bridge-side record of a diff file, or null. Shape is engine-specific; only this file reads it. */
  D.record = (file) => {
    const bridge = window.prManager && window.prManager.pierreBridge;
    return (bridge && bridge.files && bridge.files.get(file)) || null;
  };

  /**
   * True when the engine is not going to re-create files on its own account.
   *
   * On the current engine the highlight worker pool starts with the page, and
   * a file that rendered before the pool was ready is rebuilt from scratch (a
   * new vendor instance, new rows, context the application revealed applied
   * again) one animation frame after the pool reports ready. Under load that
   * is hundreds of milliseconds after the first rows are on screen. Anything
   * that holds a row, measures geometry, or puts a different diff on screen
   * by hand must wait for it. A pool that failed to start is settled: the
   * bridge dropped it and rebuilt on the main thread in the same task.
   */
  D.engineSettled = () => {
    const bridge = window.prManager && window.prManager.pierreBridge;
    if (!bridge) return false;
    if (!bridge.workerManager) return true;
    if (!bridge._workerReady) return false;
    for (const state of bridge.files.values()) {
      const rebuildPending = !state.usesWorkerManager && !state.forcePlainText && state.container && state.patch;
      if (rebuildPending) return false;
    }
    return true;
  };

  /**
   * True when what is on screen for `file` is the diff the bridge last asked
   * for. Replacing a file's diff (content upgrade, revealed context) is
   * displayed a worker round trip later; until then the old rows are still
   * in the DOM and will be replaced. A collapsed file displays no rows, so
   * there is nothing to wait for.
   */
  D.isDisplayCurrent = (file) => {
    if (!D.engineSettled()) return false;
    const record = D.record(file);
    const instance = record && record.instance;
    if (!instance || record.collapsed) return true;
    if (typeof instance.getRenderedDiff !== 'function') return true;
    return instance.getRenderedDiff() === instance.fileDiff;
  };

  /**
   * True once the application has taken `file`'s contents and asked the
   * engine for the upgraded diff, whether or not that diff is displayed yet.
   */
  D.contentsTaken = (file) => {
    const record = D.record(file);
    return !!(record && record.baseMetadata);
  };

  /** True when `file` has been upgraded with its contents AND that diff is what is displayed. */
  D.isUpgraded = (file) => D.contentsTaken(file) && D.isDisplayCurrent(file);

  /** True when no content upgrade is queued or in flight. */
  D.upgradesIdle = () => {
    const pm = window.prManager;
    if (!pm) return false;
    const promises = pm._pierreContentUpgradePromises;
    return D.engineSettled() && !pm._fileContentsUpgradeState && (!promises || promises.size === 0);
  };

  /**
   * Everything a reader can see of one diff file, as data. Used by the golden
   * dump (tests/parity/dump.mjs) and by render assertions.
   */
  D.dump = (file) => {
    const wrapper = D.wrapper(file);
    if (!wrapper) return null;
    const root = D.root(file);
    const pre = root && root.querySelector('pre[data-diff-type]');
    const header = wrapper.querySelector('.d2h-file-header');
    const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null);
    const out = {
      file,
      collapsed: wrapper.classList.contains('collapsed'),
      classes: [...wrapper.classList].filter((c) => c !== 'd2h-file-wrapper').sort(),
      header: header ? {
        name: text(header.querySelector('.d2h-file-name')),
        viewed: !!(header.querySelector('.file-viewed-checkbox') || {}).checked,
        badges: [...header.querySelectorAll('.generated-badge, .context-badge, .file-status-badge, .renamed-badge')].map(text),
        hasChatButton: !!header.querySelector('.file-header-chat-btn'),
        hasCommentButton: !!header.querySelector('.file-header-comment-btn'),
      } : null,
      diffType: pre ? pre.getAttribute('data-diff-type') : null,
      columns: [],
      separators: [],
      expandControls: 0,
      annotations: [],
      notices: [...wrapper.querySelectorAll('.large-diff-placeholder, .pierre-binary-file')].map(text),
    };
    if (pre) {
      for (const code of pre.querySelectorAll('code')) {
        const name = code.hasAttribute('data-additions') ? 'additions'
          : code.hasAttribute('data-deletions') ? 'deletions'
            : code.hasAttribute('data-unified') ? 'unified' : 'unknown';
        const rows = [...code.querySelectorAll('[data-content] > [data-line]')].map((row) => ({
          type: row.getAttribute('data-line-type'),
          line: row.getAttribute('data-line'),
          alt: row.getAttribute('data-alt-line'),
          text: row.textContent,
        }));
        out.columns.push({ name, rows });
      }
      out.separators = [...pre.querySelectorAll('[data-content] > [data-separator]')].map(text);
      out.expandControls = pre.querySelectorAll('[data-gutter] [data-expand-button]').length;
    }
    const host = D.hostOf(wrapper);
    if (host) {
      out.annotations = [...host.querySelectorAll(':scope > [data-annotation-slot]')].map((slotWrapper) => ({
        slot: slotWrapper.getAttribute('slot'),
        cards: [...slotWrapper.children].map((card) => ({
          classes: [...card.classList].sort().join(' '),
          commentId: card.getAttribute('data-comment-id'),
          suggestionId: card.getAttribute('data-suggestion-id'),
        })),
      }));
    }
    return out;
  };

  /** Bottom edge (viewport y) of whatever is pinned above the diff: the toolbar. */
  D.pinnedBottom = () => {
    const toolbar = document.querySelector('.diff-toolbar');
    if (toolbar && toolbar.getBoundingClientRect().height > 0) return toolbar.getBoundingClientRect().bottom;
    return D.scroller().getBoundingClientRect().top;
  };

  /** Syntax highlighting of a file's rows on screen: how many rows carry tokens, and the token colours in use. */
  D.tokenInfo = (file) => {
    const rows = D.rows(file);
    const colors = new Set();
    let highlightedRows = 0;
    for (const row of rows) {
      const tokens = row.querySelectorAll('span[style*="--diffs-token"]');
      if (tokens.length > 0) highlightedRows++;
      for (const token of tokens) colors.add(getComputedStyle(token).color);
    }
    return { rows: rows.length, highlightedRows, colors: [...colors].sort() };
  };

  /** How far a file's code overflows horizontally (0 when every line wraps), and its row heights. */
  D.wrapInfo = (file) => {
    const pre = D.pre(file);
    const wrapper = D.wrapper(file);
    if (!pre || !wrapper) return null;
    const scroller = D.scroller();
    const over = (el) => (el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0);
    const heights = D.rows(file).map((row) => row.getBoundingClientRect().height);
    return {
      overflow: Math.max(over(pre), over(wrapper), over(scroller), ...[...pre.querySelectorAll('code')].map(over)),
      minRowHeight: Math.min(...heights),
      maxRowHeight: Math.max(...heights),
    };
  };

  /**
   * The first code row a reader sees at the top of the diff: the first row
   * (any file) whose top edge is below the pinned toolbar and that file's
   * sticky header.
   */
  D.firstVisibleRow = () => {
    const pinned = D.pinnedBottom();
    let best = null;
    for (const wrapper of D.wrappers()) {
      if (wrapper.classList.contains('context-file')) continue;
      const rect = wrapper.getBoundingClientRect();
      if (rect.bottom <= pinned || rect.top >= window.innerHeight) continue;
      const header = wrapper.querySelector('.d2h-file-header');
      const limit = Math.max(pinned, header ? header.getBoundingClientRect().bottom : pinned);
      for (const row of D.rows(wrapper.dataset.fileName)) {
        const r = row.getBoundingClientRect();
        if (r.height === 0 || r.top < limit - 0.5) continue;
        if (!best || r.top < best.top) {
          best = {
            file: wrapper.dataset.fileName,
            line: Number(row.getAttribute('data-line')),
            type: row.getAttribute('data-line-type'),
            text: row.textContent,
            top: r.top,
          };
        }
        break;
      }
    }
    return best;
  };

  /** Viewport box of the row showing `line` on `side` of `file` (its content cell, not the number), or null. */
  D.rowBox = (file, line, side) => {
    const pre = D.pre(file);
    if (!pre) return null;
    const deletion = side === 'deletions' || side === 'LEFT';
    const rows = [...pre.querySelectorAll(`[data-content] > [data-line="${line}"]`)].filter((row) => {
      const type = row.getAttribute('data-line-type');
      const code = row.closest('code');
      if (code.hasAttribute('data-deletions')) return deletion;
      if (code.hasAttribute('data-additions')) return !deletion;
      return deletion ? type === 'change-deletion' : type !== 'change-deletion';
    });
    return rows.length ? { ...box(rows[0]), text: rows[0].textContent, type: rows[0].getAttribute('data-line-type') } : null;
  };

  /**
   * Line numbers of `file` that are currently flashed (the brief highlight a
   * navigation puts on its target lines), for a diff file or a context file.
   */
  D.flashedLines = (file) => {
    const context = D.contextWrapper(file);
    if (context) {
      return [...context.querySelectorAll('tr.chat-line-highlight[data-line-number]')]
        .map((tr) => Number(tr.dataset.lineNumber));
    }
    return D.rows(file).filter((row) => row.classList.contains('pierre-line-highlight'))
      .map((row) => Number(row.getAttribute('data-line')));
  };

  /** The text the user has selected, wherever the selection is (document or inside a diff's shadow tree). */
  D.selectedText = () => {
    const direct = String(document.getSelection() || '');
    if (direct) return direct;
    for (const host of D.hosts()) {
      const root = host.shadowRoot;
      const selection = root && typeof root.getSelection === 'function' ? root.getSelection() : null;
      if (selection && String(selection)) return String(selection);
    }
    return '';
  };

  // ---- context files -------------------------------------------------
  // A context file is rendered by the application's table renderer today
  // (one <tr> per line, gap rows with expand buttons). Everything that reads
  // that markup is here, so the same specs can run if context files move into
  // the vendor viewer.

  /** Line rows of a context file, in order (no gap rows, no card rows). */
  D.contextLineRows = (file) => {
    const w = D.contextWrapper(file);
    if (!w) return [];
    return [...w.querySelectorAll('.d2h-diff-table tr[data-line-number]')]
      .filter((tr) => !tr.classList.contains('context-expand-row') && tr.querySelector('.d2h-code-linenumber'));
  };

  D.contextLineRow = (file, line) => D.contextLineRows(file)
    .find((tr) => Number(tr.dataset.lineNumber) === Number(line)) || null;

  /** Gap rows of a context file ("N hidden lines" with expand buttons), in order. */
  D.contextGapRows = (file) => {
    const w = D.contextWrapper(file);
    return w ? [...w.querySelectorAll('.d2h-diff-table tr.context-expand-row')] : [];
  };

  const gapDirections = (row) => [...row.querySelectorAll('.expand-button')].map((b) => {
    const title = (b.title || '').toLowerCase();
    return title.includes('all') ? 'all' : title.includes('up') ? 'up' : title.includes('down') ? 'down' : 'unknown';
  });

  /** What a reader sees of a context file, as data. */
  D.contextDump = (file) => {
    const w = D.contextWrapper(file);
    if (!w) return null;
    const header = w.querySelector('.d2h-file-header');
    const sequence = [];
    for (const tr of w.querySelectorAll('.d2h-diff-table tr')) {
      if (tr.classList.contains('context-expand-row')) {
        const info = tr.querySelector('.expand-info');
        const match = info && /(\d+) hidden lines/.exec(info.textContent || '');
        sequence.push({ kind: 'gap', hidden: match ? Number(match[1]) : null, label: info ? info.textContent.trim() : '', directions: gapDirections(tr) });
      } else if (tr.classList.contains('context-chunk-separator-row')) {
        sequence.push({ kind: 'separator' });
      } else if (tr.dataset.lineNumber && tr.querySelector('.d2h-code-linenumber')) {
        const content = tr.querySelector('.d2h-code-line-ctn');
        sequence.push({ kind: 'line', line: Number(tr.dataset.lineNumber), text: content ? content.textContent : '' });
      } else {
        const card = tr.matches('.user-comment-row, .ai-suggestion-row') ? tr
          : tr.querySelector('.user-comment-row, .ai-suggestion, .user-comment-form');
        if (card) {
          sequence.push({
            kind: 'card',
            classes: [...card.classList].sort().join(' '),
            commentId: card.getAttribute('data-comment-id') || (card.querySelector('[data-comment-id]') || {}).dataset?.commentId || null,
            suggestionId: card.getAttribute('data-suggestion-id') || (card.querySelector('[data-suggestion-id]') || {}).dataset?.suggestionId || null,
          });
        }
      }
    }
    const lines = sequence.filter((x) => x.kind === 'line').map((x) => x.line);
    const ranges = [];
    for (const n of lines) {
      const last = ranges[ranges.length - 1];
      if (last && n === last.end + 1) last.end = n;
      else ranges.push({ start: n, end: n });
    }
    const body = w.querySelector('.d2h-file-body');
    return {
      file,
      collapsed: w.classList.contains('collapsed'),
      bodyVisible: !!body && body.getBoundingClientRect().height > 0,
      header: header ? {
        name: (header.querySelector('.d2h-file-name') || {}).textContent || null,
        badge: ((header.querySelector('.context-badge') || {}).textContent || '').trim(),
        viewed: !!(header.querySelector('.file-viewed-checkbox') || {}).checked,
        hasCommentButton: !!header.querySelector('.file-header-comment-btn'),
        hasChatButton: !!header.querySelector('.file-header-chat-btn'),
        hasDismissButton: !!header.querySelector('.context-file-dismiss'),
      } : null,
      lines,
      ranges,
      gaps: sequence.filter((x) => x.kind === 'gap'),
      separators: sequence.filter((x) => x.kind === 'separator').length,
      sequence,
    };
  };

  window.__diffDom = D;
}
/* eslint-enable no-undef */

async function lib(page) {
  await page.evaluate(installInPage);
}

/** Run `fn(D, arg)` in the page with the in-page library as first argument. */
async function inPage(page, fn, arg) {
  await lib(page);
  return page.evaluate(
    ({ source, arg: inner }) => {
      // eslint-disable-next-line no-new-func
      const f = new Function(`return (${source})`)();
      return f(window.__diffDom, inner);
    },
    { source: fn.toString(), arg }
  );
}

/** Poll `fn(D, arg)` in the page until it returns a truthy value. */
async function waitInPage(page, fn, arg, { timeout = 10000 } = {}) {
  const source = fn.toString();
  const installer = installInPage.toString();
  return page.waitForFunction(
    ({ source: s, installer: i, arg: inner }) => {
      if (!window.__diffDom) {
        // eslint-disable-next-line no-new-func
        new Function(`return (${i})`)()();
      }
      // eslint-disable-next-line no-new-func
      return new Function(`return (${s})`)()(window.__diffDom, inner);
    },
    { source, installer, arg },
    { timeout }
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Locator of a diff file's identity element (header, zone and cards are inside it). */
function fileWrapper(page, file) {
  return page.locator(fileSelector(file));
}

/** Locator of a context file's wrapper. */
function contextFile(page, file) {
  return page.locator(contextFileSelector(file));
}

/** Locator of every file wrapper in the diff pane (diff and context), in document order. */
function allFileWrappers(page) {
  return page.locator('#diff-container .d2h-file-wrapper[data-file-name]');
}

/**
 * The files in the diff pane, top to bottom, as the user sees them.
 * @returns {Promise<Array<{file: string, kind: 'diff'|'context', top: number}>>}
 */
async function filesInPane(page) {
  return inPage(page, (D) => D.wrappers()
    .map((w) => ({
      file: w.dataset.fileName,
      kind: w.classList.contains('context-file') ? 'context' : 'diff',
      top: w.getBoundingClientRect().top,
    }))
    .sort((a, b) => a.top - b.top));
}

/**
 * Wait until the diff has rendered: at least one file is present and at
 * least one code row has been painted.
 */
async function waitForDiffToRender(page, timeout = 10000) {
  await page.waitForSelector('[data-file-name]', { timeout });
  await waitInPage(page, (D) => D.anyRowRendered(), null, { timeout });
}

/** Wait until `file` (a diff file) has rendered at least one code row. */
async function waitForFileRendered(page, file, { timeout = 10000 } = {}) {
  await waitInPage(page, (D, f) => D.rows(f).length > 0, file, { timeout });
}

/**
 * Number of code rows `file` currently shows (0 when collapsed, deferred or
 * not rendered). A row counts when it has a box, wherever it is relative to
 * the viewport: the current engine keeps a collapsed file's rows in the DOM,
 * hidden, until its next re-render, and a reader sees none of them.
 */
async function rowCount(page, file) {
  return inPage(page, (D, f) => D.rows(f).filter((row) => row.getClientRects().length > 0).length, file);
}

/** True when `file` has a rendered diff body at all (rows or not). False for a deferred or never-rendered file. */
async function hasRenderedBody(page, file) {
  return inPage(page, (D, f) => !!D.pre(f), file);
}

// ---------------------------------------------------------------------------
// Rows, line numbers, separators, expansion (locators; scope is a Page or a
// Locator such as fileWrapper(page, file))
// ---------------------------------------------------------------------------

/** Code rows. */
function rows(scope) {
  return scope.locator(ROW);
}

/**
 * Code rows of the given kinds.
 * @param {...('addition'|'deletion'|'context'|'expanded'|'anyContext')} kinds
 */
function rowsOfType(scope, ...kinds) {
  const types = kinds.flatMap((kind) => {
    if (!LINE_TYPE[kind]) throw new Error(`rowsOfType: unknown kind "${kind}"`);
    return LINE_TYPE[kind];
  });
  return scope.locator(types.map((t) => `[data-line-type="${t}"]${ROW}`).join(', '));
}

/** Line-number cells, one per row and side, in document order. */
function lineNumberCells(scope) {
  return scope.locator(NUMBER_CELL);
}

/**
 * The line-number cell showing `line`.
 *
 * A number alone is ambiguous: old line 3 and new line 3 are different rows.
 * With `side`, the cell is the one for that side's line in either layout: in
 * split layout the cell in that side's column; in unified layout (one column,
 * one number cell per row, context rows numbered by their new line) the
 * deletion row for 'deletions' and the addition or context row for
 * 'additions'.
 *
 * @param {Object} [options]
 * @param {('additions'|'deletions'|'RIGHT'|'LEFT')} [options.side] - without
 *   it, every cell showing that number.
 */
function lineNumberCell(scope, line, { side } = {}) {
  const column = sideColumn(side);
  const cell = `[data-column-number="${line}"]`;
  if (column === 'additions') {
    return scope.locator(
      `${COLUMN.additions} ${cell}, ${COLUMN.unified} ${cell}:not([data-line-type="change-deletion"])`
    );
  }
  if (column === 'deletions') {
    return scope.locator(
      `${COLUMN.deletions} ${cell}, ${COLUMN.unified} ${cell}[data-line-type="change-deletion"]`
    );
  }
  return scope.locator(cell);
}

/** Hunk separators ("N unmodified lines" rows and hunk headers). */
function separators(scope) {
  return scope.locator(SEPARATOR);
}

/** Separators that currently offer an expand control. */
function expandableSeparators(scope) {
  return scope.locator(`${SEPARATOR}:has(${EXPAND_ANY})`);
}

/**
 * Expand controls. `scope` may be a separator, a file, or the page.
 * @param {('up'|'down'|'both'|'any'|'directional')} [direction='any'] -
 *   'directional' is any of up/down/both (the controls a user clicks to
 *   expand by one step, as opposed to "expand all").
 */
function expandControls(scope, direction = 'any') {
  if (direction === 'directional') {
    return scope.locator(`${EXPAND.up}, ${EXPAND.down}, ${EXPAND.both}`);
  }
  if (!EXPAND[direction]) throw new Error(`expandControls: unknown direction "${direction}"`);
  return scope.locator(EXPAND[direction]);
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * Selector of a line-level annotation card: a card slotted under a diff line.
 * Excludes cards in the file-comment zone, which are not line annotations.
 * @param {string} cardSelector - e.g. '.user-comment-row'
 * @param {string} [fileScope] - a selector to scope to, e.g. fileSelector(f)
 */
function lineCardSelector(cardSelector, fileScope = '#diff-container') {
  return `${fileScope} ${ANNOTATION_SLOT} > ${cardSelector}`;
}

/** Locator of line-level annotation cards (see lineCardSelector). */
function lineCards(page, cardSelector, fileScope) {
  return page.locator(lineCardSelector(cardSelector, fileScope));
}

/**
 * The per-line annotation groups: one per (line, side) that has at least one
 * annotation. `having` narrows to groups that directly contain a match.
 */
function annotationGroups(page, { having, fileScope = '#diff-container' } = {}) {
  return page.locator(`${fileScope} ${ANNOTATION_SLOT}${having ? `:has(> ${having})` : ''}`);
}

/** Selector for something inside any line-level annotation group. */
function inAnnotationGroup(inner, fileScope = '#diff-container') {
  return `${fileScope} ${ANNOTATION_SLOT} ${inner}`;
}

/** Locator of an inline comment card by id, wherever in the diff it is slotted. */
function inlineComment(page, id) {
  return page.locator(`#diff-container .user-comment-row[data-comment-id="${id}"]`);
}

/** Locator of an inline suggestion card by id. */
function inlineSuggestion(page, id) {
  return page.locator(`#diff-container .ai-suggestion[data-suggestion-id="${id}"]`);
}

/**
 * Wait until the annotation whose text contains `text` is slotted into the
 * given code column.
 */
async function expectAnnotationInColumn(page, { text, column, timeout = 5000 }) {
  await waitInPage(
    page,
    (D, { text: needle, column: col }) => D.annotationColumn(
      needle, '.user-comment-row, .ai-suggestion-row, .ai-suggestion, .hunk-summary-row'
    ) === col,
    { text, column },
    { timeout }
  );
}

/** Metrics of the vendor cell that hosts the card containing `text` (null until slotted). */
async function annotationCell(page, file, text) {
  return inPage(page, (D, a) => D.annotationCell(a.file, a.text), { file, text });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Wait until every rendered diff file reports the given layout, or only
 * `fileName` when given. 'single' is one code column (the unified layout, and
 * also a one-sided file in split layout); 'split' is two.
 */
async function waitForDiffType(page, diffType, timeout = 5000, { fileName } = {}) {
  await waitInPage(page, (D, { type, file }) => {
    if (file) return D.diffType(file) === type;
    const hosts = D.hosts();
    if (hosts.length === 0) return false;
    return hosts.every((host) => {
      const pre = host.shadowRoot && host.shadowRoot.querySelector('pre[data-diff-type]');
      return !!pre && pre.getAttribute('data-diff-type') === type;
    });
  }, { type: diffType, file: fileName || null }, { timeout });
}

/** True when any rendered file is in two-column layout. */
async function anyFileInSplitLayout(page) {
  return inPage(page, (D) => D.hosts().some(
    (h) => h.shadowRoot && h.shadowRoot.querySelector('pre[data-diff-type="split"]')
  ));
}

/** Layout of one file: diffType, column and gutter boxes (see D.layout). Null until rendered. */
async function fileLayout(page, file) {
  return inPage(page, (D, f) => D.layout(f), file);
}

/**
 * Hit-test the left edge of an element inside a file, through shadow roots:
 * is what is painted there inside `insideSelector`?
 * @returns {Promise<{inside: boolean, left: number}|null>}
 */
async function paintProbe(page, file, targetSelector, insideSelector) {
  return inPage(page, async (D, a) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const scope = D.wrapper(a.file);
    const el = scope && scope.querySelector(a.target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = D.elementFromPointDeep(r.left + 4, r.top + r.height / 2);
    return { inside: !!(hit && hit.closest && hit.closest(a.inside)), left: Math.round(r.left) };
  }, { file, target: targetSelector, inside: insideSelector });
}

// ---------------------------------------------------------------------------
// Content upgrade, reveal, expansion state
// ---------------------------------------------------------------------------

/**
 * Wait until `file`'s diff has been upgraded with its full contents, or, with
 * no file, until no upgrade is queued or in flight. After this the file's
 * rows are stable (no pending re-layout) and expand controls exist where
 * there is hidden context.
 */
async function waitForContentUpgrade(page, file, { timeout = 15000 } = {}) {
  if (file) {
    await waitInPage(page, (D, f) => D.isUpgraded(f), file, { timeout });
  } else {
    await waitInPage(page, (D) => D.upgradesIdle(), null, { timeout });
  }
}

/** Ask the application to upgrade `file` now (the path a reveal takes) and wait for it. */
async function ensureContentUpgrade(page, file) {
  return page.evaluate((f) => window.prManager._ensurePierreContentUpgrade(f), file);
}

/**
 * Wait until `file` shows, highlighted, the diff the engine was last given
 * for it, whether or not its contents have arrived. With the file-contents
 * requests held (`holdFileContents` in helpers.js) this is the patch-only
 * render at rest: the state a content upgrade then replaces.
 *
 * "Highlighted" matters to what happens next. The engine keeps an old diff
 * on screen while its replacement is being highlighted only when the old one
 * had its highlight result; a diff still showing plain rows is replaced at
 * once (vendor `DiffHunksRenderer.canRenderDiff`).
 */
async function waitForHighlightedDisplay(page, file, { timeout = 15000 } = {}) {
  await waitInPage(page, (D, f) => D.isDisplayCurrent(f) && D.tokenInfo(f).highlightedRows > 0, file, { timeout });
}

/**
 * True while `file`'s content upgrade has been taken by the application and
 * the upgraded diff is not what is displayed yet: the window between the two
 * that `holdWorkerResults` keeps open.
 */
async function upgradeAwaitingDisplay(page, file) {
  return inPage(page, (D, f) => D.contentsTaken(f) && !D.isDisplayCurrent(f), file);
}

/**
 * True once the application has taken `file`'s contents for its upgrade,
 * whether or not the upgraded diff is displayed yet. A test that asserts an
 * upgrade has NOT happened asks this; one that needs the upgraded rows waits
 * with `waitForContentUpgrade`.
 */
async function contentsApplied(page, file) {
  return inPage(page, (D, f) => D.contentsTaken(f), file);
}

/**
 * Watch up to `frames` animation frames and return how many passed before
 * the application took `file`'s contents (`frames` when it never did).
 */
async function framesWithoutUpgrade(page, file, frames) {
  return inPage(page, async (D, a) => {
    let seen = 0;
    for (let i = 0; i < a.frames; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (D.contentsTaken(a.file)) break;
      seen++;
    }
    return seen;
  }, { file, frames });
}

/** The application's answer to "is this line on screen (not in a hidden gap)?". */
async function isLineVisible(page, file, line, side = 'RIGHT') {
  return page.evaluate(
    ({ f, l, s }) => window.prManager.pierreBridge.isLineVisible(f, l, s),
    { f: file, l: line, s: side }
  );
}

/**
 * Reveal a line that is hidden in a gap, the way every feature does
 * (comments, suggestions, chat links): through `ensureLinesVisible`.
 */
async function revealOffHunkLine(page, file, line, { side = 'RIGHT', lineEnd = line } = {}) {
  await page.evaluate(
    ({ f, l, e, s }) => window.prManager.ensureLinesVisible([{ file: f, line_start: l, line_end: e, side: s }]),
    { f: file, l: line, e: lineEnd, s: side }
  );
}

/**
 * The hunk of `file` whose new-side range contains `line`.
 * @returns {Promise<{index: number, additionStart: number, additionCount: number}|null>}
 */
async function hunkContaining(page, file, line) {
  return inPage(page, (D, a) => {
    const record = D.record(a.file);
    const metadata = record && record.instance && record.instance.fileDiff;
    if (!metadata) return null;
    const index = metadata.hunks.findIndex((h) => h.additionStart <= a.line && h.additionStart + h.additionCount > a.line);
    if (index < 0) return null;
    const hunk = metadata.hunks[index];
    return { index, additionStart: hunk.additionStart, additionCount: hunk.additionCount };
  }, { file, line });
}

/**
 * Expand hidden context next to a hunk the way the vendor's own expand
 * control does, by an exact number of lines (a click expands by the
 * configured step, which a scenario cannot choose).
 * @param {Object} options
 * @param {number} options.hunkIndex
 * @param {('up'|'down'|'both')} options.direction
 * @param {number} options.lines
 */
async function expandHunkBy(page, file, { hunkIndex, direction, lines }) {
  // Not before the file shows its upgraded diff on a settled engine. The
  // control this stands in for does not exist earlier, and on the current
  // engine the expansion lives in the vendor instance: a file rebuilt for
  // the worker pool afterwards gets a new instance and the expansion is
  // gone for good (ledger H59; the cause of the "manually expanded lines"
  // flake of inline-feedback-context.spec.js under load).
  await waitForContentUpgrade(page, file);
  await inPage(page, (D, a) => {
    const record = D.record(a.file);
    const instance = record && record.instance;
    if (!instance) throw new Error(`expandHunkBy: ${a.file} is not rendered`);
    instance.expandHunk(a.hunkIndex, a.direction, a.lines);
    if (typeof instance.rerender === 'function') instance.rerender();
  }, { file, hunkIndex, direction, lines });
}

/**
 * Re-display `file` from its upgraded base diff, dropping whatever context
 * was revealed on screen while the application's record of revealed ranges
 * and its annotations stay. Models the display falling behind the data.
 */
async function redisplayBaseDiff(page, file) {
  // Not before the engine has settled: a file rebuilt for the worker pool
  // afterwards is rebuilt with every revealed range applied, which undoes
  // this (the cause of this scenario's flake under load, ledger H59).
  await waitInPage(page, (D) => D.engineSettled(), null, { timeout: 20000 });
  await inPage(page, (D, f) => {
    const bridge = window.prManager.pierreBridge;
    const record = D.record(f);
    if (!record || !record.baseMetadata) throw new Error(`redisplayBaseDiff: ${f} is not upgraded`);
    bridge._renderWithFileDiff(record, record.baseMetadata);
  }, file);
}

/**
 * Hold back every result the diff worker pool delivers until `release()`.
 * While held, a diff whose content changed stays displayed as it was.
 * `arrived` resolves in the page (`window.__diffWorkerHold.arrived`) once the
 * first held result has come in.
 * @returns {Promise<{release: () => Promise<void>}>}
 */
async function holdWorkerResults(page) {
  await page.evaluate(() => {
    if (window.__diffWorkerHold) return;
    const prototype = window.PierreDiffs.WorkerPoolManager.prototype;
    const original = prototype.handleWorkerMessage;
    const queued = [];
    let markArrived;
    const hold = {
      arrived: new Promise((resolve) => { markArrived = resolve; }),
      released: false,
      release() {
        if (hold.released) return;
        hold.released = true;
        prototype.handleWorkerMessage = original;
        for (const deliver of queued.splice(0)) deliver();
      },
    };
    prototype.handleWorkerMessage = function heldHandleWorkerMessage(...args) {
      queued.push(() => original.apply(this, args));
      markArrived();
    };
    window.__diffWorkerHold = hold;
  });
  return {
    release: async () => {
      await page.evaluate(() => {
        if (!window.__diffWorkerHold) return;
        window.__diffWorkerHold.release();
        delete window.__diffWorkerHold;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Pointer: hover, gutter buttons, line selection
// ---------------------------------------------------------------------------

/**
 * Wait until the diff has stopped re-laying itself out after a load: no
 * content upgrade is queued or in flight, and every rendered file displays
 * the diff it was last given.
 *
 * Pointing at a row before that is pointing at a moving target. Each upgrade
 * re-creates its file's rows and usually makes the file taller, which moves
 * every file below it; on the current engine a gutter button positioned for a
 * file that then moved is left where the file used to be, on top of another
 * file's button, and takes its click (the "subtree intercepts pointer events"
 * failures of comment-crud and comments-review in the phase 1 and 2 logs).
 */
async function waitForDiffSettled(page, { timeout = 15000 } = {}) {
  await waitInPage(page, (D) => D.upgradesIdle() && D.wrappers()
    .filter((w) => !w.classList.contains('context-file'))
    .every((w) => D.isDisplayCurrent(w.dataset.fileName)), null, { timeout });
}

/**
 * Hover the Nth line-number cell of the page (document order) to reveal the
 * gutter buttons, once the diff has settled (see waitForDiffSettled).
 */
async function hoverDiffLine(page, lineIndex = 0) {
  await waitForDiffSettled(page);
  const cell = lineNumberCells(page).nth(lineIndex);
  await cell.hover();
  return cell;
}

/**
 * Open a line comment form the way a reader does: point at the line's number,
 * click the comment button that appears. Resolves when one more form is open.
 *
 * On the current engine the button container is positioned by the
 * application, and one that was positioned for a file that has since moved
 * can be left over the hovered row and take the click (ledger H54;
 * gutter-buttons.spec.js is the test of that). A click that never reached the
 * button is made again after moving the pointer away and back, which is what
 * clears a stale container. The click is the last step of an attempt, so a
 * form is never opened twice.
 *
 * @param {Object} target - `{file, line, side}` or `{lineIndex}` (Nth number cell of the page)
 * @returns {Promise<void>}
 */
async function openLineCommentForm(page, { file, line, side = 'additions', lineIndex } = {}) {
  const scope = file ? fileWrapper(page, file) : page;
  const cell = file
    ? lineNumberCell(scope, line, { side }).first()
    : lineNumberCells(page).nth(lineIndex || 0);
  const forms = page.locator('.user-comment-form');
  const before = await forms.count();
  await expect(async () => {
    await page.mouse.move(0, 0);
    await cell.hover({ timeout: 2000 });
    await scope.locator('.pierre-comment-btn').first().click({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  await expect(forms).toHaveCount(before + 1);
}

/**
 * Select a range of lines with a real pointer drag down the line-number
 * column: press on the first line's number, drag to the last line's number,
 * release. Resolves once the application reports that selection.
 *
 * The press lands on the LEFT part of the number cell. The gutter-button
 * container is positioned over the right part of the hovered cell, and a
 * press on a button starts the application's own button drag instead (a
 * different code path: `wrapButton` in pierre-bridge.js).
 *
 * @param {Object} options
 * @param {string} options.file
 * @param {number} options.start - first line (number shown in the gutter)
 * @param {number} options.end - last line
 * @param {('additions'|'deletions')} [options.side='additions']
 * @param {boolean} [options.waitForUpgrade=true] - false for a file whose
 *   contents are never loaded (too large, or the request is held by the test)
 */
async function selectLineRange(page, { file, start, end, side = 'additions', waitForUpgrade = true }) {
  const wrapper = fileWrapper(page, file);
  const cellFor = (line) => lineNumberCell(wrapper, line, { side }).first();
  // The content upgrade re-creates every row of the file and drops a
  // selection made before it; select only once that has been displayed.
  if (waitForUpgrade) await waitForContentUpgrade(page, file);
  const startCell = cellFor(start);
  const endCell = cellFor(end);
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  // Rows are also re-created whenever the file's annotations change (comments
  // and suggestions arrive after the diff), and there is no signal for "the
  // last of them has arrived". A drag whose rows were replaced under it is
  // simply made again, as a user would; what must hold is the selection the
  // application reports once the pointer is released.
  await expect(async () => {
    await startCell.scrollIntoViewIfNeeded({ timeout: 2000 });
    const from = await startCell.boundingBox();
    const to = await endCell.boundingBox();
    if (!from || !to) throw new Error('selectLineRange: both ends of the range must be on screen');
    const x = from.x + 6;
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(x, to.y + to.height / 2, { steps: 8 });
    } finally {
      await page.mouse.up();
    }
    const selection = await lineSelection(page, file);
    if (!selection || selection.start !== first || selection.end !== last) {
      throw new Error(`selectLineRange: wanted ${first}-${last}, the application reports ${JSON.stringify(selection)}`);
    }
  }).toPass({ timeout: 15000 });
}

/**
 * State of every gutter-button container on the page, judged the way a user
 * would: is it showing, and if so is it on the row the pointer is over?
 *
 * `stale` is a container that is visible anywhere else: left behind after the
 * pointer went away, or stuck to the viewport while the diff moved under it.
 * A button on the row under the pointer is never stale, whichever mechanism
 * put it there.
 *
 * @param {{x: number, y: number}|null} pointer - where the test last put the
 *   mouse, in viewport coordinates (null when it is parked outside the diff)
 * @returns {Promise<Array<{visible: boolean, stale: boolean}>>}
 */
async function gutterButtonsState(page, pointer) {
  return inPage(page, (D, p) => {
    let rowBox = null;
    if (p) {
      const hit = D.elementFromPointDeep(p.x, p.y);
      const row = hit && hit.closest && hit.closest('[data-line], [data-column-number]');
      if (row) rowBox = row.getBoundingClientRect();
    }
    return [...document.querySelectorAll('.pierre-gutter-buttons')].map((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      const centerY = r.top + r.height / 2;
      const onPointerRow = !!rowBox && centerY >= rowBox.top - 2 && centerY <= rowBox.bottom + 2;
      return { visible, stale: visible && !onPointerRow };
    });
  }, pointer || null);
}

/**
 * A viewport point inside the content track (not the line-number gutter) of
 * the additions column of `file`, in split layout. Null until rendered.
 */
async function additionsContentPoint(page, file) {
  const layout = await fileLayout(page, file);
  if (!layout || layout.diffType !== 'split' || !layout.additionsNumberCell || !layout.additionsContent) return null;
  return {
    x: (layout.additionsNumberCell.right + layout.pre.right) / 2,
    y: layout.additionsContent.top + Math.min(40, layout.additionsContent.height / 2),
  };
}

/**
 * Scroll the diff under a parked pointer, toward whichever end has room,
 * without moving the mouse. Returns whether the position changed.
 */
async function scrollDiffUnderPointer(page) {
  return inPage(page, (D) => {
    const s = D.scroller();
    const max = s.scrollHeight - s.clientHeight;
    const before = s.scrollTop;
    s.scrollTop = before < max ? max : 0;
    return s.scrollTop !== before;
  });
}

/** The application's current line selection for `file`: `{start, end, side: 'LEFT'|'RIGHT'}` or null. */
async function lineSelection(page, file) {
  return page.evaluate((f) => window.prManager.pierreBridge.getLineSelection(f) || null, file);
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

/** scrollTop, scrollHeight and clientHeight of the element that scrolls the diff. */
async function scrollState(page) {
  return inPage(page, (D) => {
    const s = D.scroller();
    return { top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight };
  });
}

/** Set the diff's scroll position directly (no smooth scrolling). */
async function scrollDiffTo(page, top) {
  await inPage(page, (D, t) => { D.scroller().scrollTop = t; }, top);
}

/** Scroll the diff to its very top or very bottom, by real scrolling of the scroll container. */
async function scrollDiffToEdge(page, edge) {
  await inPage(page, (D, e) => {
    const s = D.scroller();
    s.scrollTop = e === 'bottom' ? s.scrollHeight : 0;
  }, edge);
}

/**
 * Walk the whole diff from top to bottom by real scrolling, a viewport at a
 * time, giving each stretch a frame to render. Ends at the bottom.
 */
async function scrollThroughDiff(page) {
  await scrollDiffToEdge(page, 'top');
  for (;;) {
    const state = await scrollState(page);
    if (state.top + state.client >= state.height - 1) break;
    await scrollDiffTo(page, state.top + state.client);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}

/**
 * Bring a diff file's header to the top of the diff viewport through the
 * application's own navigation (the sidebar click path), and wait until its
 * wrapper is in the viewport.
 */
async function scrollFileIntoView(page, file, { timeout = 10000 } = {}) {
  await page.evaluate((f) => window.prManager.scrollToFile(f), file);
  await page.waitForFunction((f) => {
    const w = [...document.querySelectorAll('#diff-container .d2h-file-wrapper[data-file-name]')]
      .find((el) => el.dataset.fileName === f);
    if (!w) return false;
    const r = w.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }, file, { timeout });
}

/**
 * Scroll so that `file` is far outside the viewport (at least `margin`
 * viewport heights away), toward whichever end of the diff has room. On a
 * virtualized engine this unmounts the file; on the current engine it stays
 * in the DOM. Either way a user would say "I scrolled far away from it".
 * @returns {Promise<{distance: number}>} how far the file is from the viewport, in px
 */
async function scrollFileOutOfView(page, file, { margin = 3, timeout = 10000 } = {}) {
  const result = await inPage(page, (D, a) => {
    const s = D.scroller();
    const w = D.wrapper(a.file) || D.contextWrapper(a.file);
    const view = s.clientHeight;
    const need = a.margin * view;
    if (!w) {
      // Not in the DOM at all (unmounted by a virtualized engine): already away.
      return { ok: true, distance: Infinity };
    }
    const sRect = s.getBoundingClientRect();
    const r = w.getBoundingClientRect();
    const fileTop = r.top - sRect.top + s.scrollTop;
    const fileBottom = fileTop + r.height;
    const maxTop = s.scrollHeight - view;
    // Candidate A: file above the viewport. Candidate B: file below it.
    const below = fileBottom + need; // scrollTop that puts the file `need` above
    const above = fileTop - need - view; // scrollTop that puts the file `need` below
    let target = null;
    if (below <= maxTop) target = below;
    else if (above >= 0) target = above;
    if (target == null) return { ok: false, maxTop, fileTop, fileBottom, need };
    s.scrollTop = target;
    return { ok: true, target };
  }, { file, margin });
  if (!result.ok) {
    throw new Error(`scrollFileOutOfView: the diff is too short to move ${file} ${margin} viewports away (${JSON.stringify(result)})`);
  }
  const handle = await page.waitForFunction(({ f, m }) => {
    const w = [...document.querySelectorAll('#diff-container .d2h-file-wrapper[data-file-name]')]
      .find((el) => el.dataset.fileName === f);
    if (!w) return { distance: -1 };
    const r = w.getBoundingClientRect();
    const distance = r.bottom < 0 ? -r.bottom : r.top - window.innerHeight;
    return distance >= (m - 1) * window.innerHeight ? { distance } : false;
  }, { f: file, m: margin }, { timeout });
  return handle.jsonValue();
}

/**
 * Viewport position of a file's header relative to the top of the diff's
 * visible area (0 = flush under whatever is pinned above the diff).
 * @returns {Promise<{top: number, viewportTop: number}|null>}
 */
async function headerPosition(page, file) {
  return inPage(page, (D, f) => {
    const w = D.wrapper(f) || D.contextWrapper(f);
    const header = w && w.querySelector('.d2h-file-header');
    if (!header) return null;
    const s = D.scroller();
    return { top: header.getBoundingClientRect().top - s.getBoundingClientRect().top, viewportTop: header.getBoundingClientRect().top };
  }, file);
}

/**
 * Wait until `file` shows what it is going to show: upgraded with its
 * contents and displayed, or, for a file that is never upgraded (binary, no
 * patch, too large), nothing queued or in flight and the display current.
 */
async function waitForFileSettled(page, file, { timeout = 15000 } = {}) {
  await waitInPage(page, (D, f) => D.isUpgraded(f) || (D.upgradesIdle() && D.isDisplayCurrent(f)), file, { timeout });
}

/**
 * Where a file's header landed after a navigation, the way a reader judges
 * it: its distance below the toolbar pinned above the diff (0 = flush under
 * it), and whether it is inside the viewport at all.
 * @returns {Promise<{belowPinned: number, inViewport: boolean}|null>} null when the file has no header in the DOM
 */
async function headerLanding(page, file) {
  return inPage(page, (D, f) => {
    const w = D.wrapper(f) || D.contextWrapper(f);
    const header = w && w.querySelector('.d2h-file-header');
    if (!header) return null;
    const r = header.getBoundingClientRect();
    return { belowPinned: r.top - D.pinnedBottom(), inViewport: r.bottom > 0 && r.top < window.innerHeight };
  }, file);
}

/**
 * The path of the first file in the pane (changed or context) that reaches
 * below the toolbar pinned above the diff: the file a reader is looking at.
 * Null when there is none.
 */
async function firstFileBelowToolbar(page) {
  return inPage(page, (D) => {
    const pinned = D.pinnedBottom();
    const visible = D.wrappers().find((w) => w.getBoundingClientRect().bottom > pinned + 1);
    return visible ? visible.dataset.fileName : null;
  });
}

/** Syntax highlighting on screen for `file`: `{rows, highlightedRows, colors}` (colors = distinct computed token colours). */
async function syntaxTokens(page, file) {
  return inPage(page, (D, f) => D.tokenInfo(f), file);
}

/** `{overflow, minRowHeight, maxRowHeight}` of a rendered file; overflow is 0 when every line wraps. Null until rendered. */
async function wrapInfo(page, file) {
  return inPage(page, (D, f) => D.wrapInfo(f), file);
}

/** The first code row visible under the toolbar and sticky header: `{file, line, type, text, top}` or null. */
async function firstVisibleRow(page) {
  return inPage(page, (D) => D.firstVisibleRow());
}

/** Viewport box, text and type of the row showing `line` on `side` of `file`, or null when it is not on screen. */
async function rowBox(page, file, line, side = 'additions') {
  return inPage(page, (D, a) => D.rowBox(a.file, a.line, a.side), { file, line, side });
}

/** Line numbers of `file` (diff or context) that carry the navigation flash right now, ascending and unique. */
async function flashedLines(page, file) {
  const lines = await inPage(page, (D, f) => D.flashedLines(f), file);
  return [...new Set(lines)].sort((x, y) => x - y);
}

/** The text currently selected by the user, including a selection inside a diff. */
async function selectedText(page) {
  return inPage(page, (D) => D.selectedText());
}

/**
 * Click the expand control of the Nth expandable separator of `file`
 * (0-based, top to bottom), in the gutter column, where it is clickable.
 * @param {('up'|'down'|'both'|'directional')} [direction='directional']
 */
async function clickExpandControl(page, file, index = 0, direction = 'directional') {
  const separator = expandableSeparators(fileWrapper(page, file)).nth(index);
  // Rows and separators are re-created by every re-render of the file (H43);
  // a click whose target was replaced under it never happened and is made
  // again. The click itself is the only step, so it cannot land twice.
  await expect(async () => {
    await expandControls(separator, direction).first().click({ timeout: 2000 });
  }).toPass({ timeout: 10000 });
}

/**
 * Park the pointer on a line's number cell and return where it is, in
 * viewport coordinates. Hovers again if the row was replaced under it.
 * @returns {Promise<{x: number, y: number}>}
 */
async function parkPointerOnLine(page, file, line, { side = 'additions' } = {}) {
  const cell = lineNumberCell(fileWrapper(page, file), line, { side }).first();
  let pointer = null;
  await expect(async () => {
    await cell.hover({ timeout: 2000 });
    const box = await cell.boundingBox();
    if (!box) throw new Error('parkPointerOnLine: the row was replaced while hovering');
    pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }).toPass({ timeout: 10000 });
  return pointer;
}

/**
 * What switching between unified and split keeps in place.
 *
 *   'scroll-offset'       the scroll position in pixels; the content under it
 *                         changes because row heights above change (the
 *                         current behaviour: PRManager.handleDiffViewChange
 *                         saves and restores scrollTop)
 *   'first-visible-line'  the first visible code row stays where it was (what
 *                         the virtualized viewer does by itself; plan 3.12)
 *
 * Like CONTEXT_FILE_PLACEMENT this is a behaviour the migration changes on
 * purpose, so the expectation lives here and scroll-landing.spec.js asks.
 */
const LAYOUT_TOGGLE_KEEPS = 'scroll-offset';

/**
 * Whether a background content upgrade waits while the keyboard focus is
 * inside the file it would re-render.
 *
 *   false  it does not (the current behaviour): the upgrade lands once the
 *          pointer has left the file, the rows are re-created, and a focused
 *          comment textarea in that file loses focus; its text is kept
 *   true   it waits, so typing is never interrupted (plan 3.14, new with the
 *          virtualized viewer)
 */
const UPGRADE_WAITS_FOR_FOCUS = false;

/**
 * A defect on main, characterized as it is: deleting a comment through its
 * card removes the card element and leaves the comment in the annotation
 * list the file is re-rendered from, so the next re-render of that file (a
 * reveal of hidden lines, a content upgrade) draws the deleted comment again
 * until the comments are reloaded. Phase 3 of the migration removes the
 * annotation on delete; this becomes `false` there and
 * offscreen-mutations.spec.js then asserts the comment stays gone.
 */
const DELETED_COMMENT_RETURNS_ON_RERENDER = true;

/**
 * Two defects of chat file links on main, characterized as they are
 * (chat-file-links.spec.js). Phase 7 of the migration routes these links
 * through one reveal helper and flips both.
 *
 * CHAT_LINK_REACHES_UNRENDERED_FILE (false today): a link to a line of a
 * changed file whose body has never been rendered (it has not been near the
 * viewport yet) does not arrive. ChatPanel asks the bridge whether it has the
 * file, the bridge only knows rendered files, and the fallback has no rows to
 * scroll to or flash; the diff is scrolled toward the file once, the files on
 * the way render and grow while it scrolls, and the reader is left short of
 * the file (measured: 2,810 px above its header in the 60-file corpus), with
 * nothing flashed.
 *
 * REVEALED_LINE_KEEPS_FLASH (false today): a link to a line hidden between two
 * hunks reveals the line and scrolls to it, and the flash is put on a row
 * that is replaced a moment later when the revealed diff is drawn, so the
 * line is flashed for one to three frames (measured).
 */
const CHAT_LINK_REACHES_UNRENDERED_FILE = false;
const REVEALED_LINE_KEEPS_FLASH = false;

/**
 * Where an external review thread is drawn when its list is answered while
 * its file has a new diff that is not displayed yet (a content upgrade whose
 * highlight result has not come back), and something has been added to or
 * removed from that file's cards since the file was last drawn in full (any
 * comment or suggestion reload does that).
 *
 *   'file-level'  in the file's comment zone, styled as a thread that could
 *                 not be anchored, and it stays there when the new diff is
 *                 displayed: nothing draws the threads again until the next
 *                 thread reload. A defect of main, characterized as it is
 *                 (ledger H60). `ExternalCommentManager._renderThreadPierre`
 *                 adds the annotation and looks for its card in the same
 *                 task; while a new diff awaits display the engine goes on
 *                 drawing the old diff with the annotations it was last
 *                 drawn with, so the card is not there, and the manager takes
 *                 that to mean the line is not in the diff.
 *   'line'        under its line, once, as soon as the new diff is displayed
 *
 * On an ordinary page load the window is one worker round trip wide and the
 * thread list usually misses it; rerender-overlays.spec.js holds it open.
 * Phase 3 of the migration stops the manager from reading "no card in the
 * DOM" as "line not rendered" and flips this to 'line'.
 */
const THREAD_ADDED_WHILE_DIFF_AWAITS_DISPLAY = 'file-level';

/**
 * Whether the gutter button of the last hovered row is still showing after
 * the pointer has left the diff, when the review holds the suggestions of an
 * analysis (the test server's mock analysis: six rows, two of them on one
 * line, one on the other file).
 *
 *   true   it stays, on its row, with the pointer on the page header and
 *          after further pointer moves outside the diff: a defect of main,
 *          characterized as it is (gutter-buttons.spec.js). Measured 27 of
 *          27 with those suggestions on the review when the page loads, in
 *          both modes and both layouts; 0 of 15 on an empty review, and 0 of
 *          119 with a single comment or a single suggestion on any line
 *          (ledger H66). What in the six rows does it was not isolated.
 *   false  it is cleared, as it is on an empty review
 *
 * Until the fixture reset the reviews between tests, this showed as the
 * suite's baseline "known flake": the test for a clean review failed when
 * an earlier spec of the same worker had left its analysis on the review.
 * The fallback positioner this lives in is not ported to the virtualized
 * viewer (plan 3.13); the phase that ports the gutter flips this.
 */
const GUTTER_BUTTON_STAYS_WITH_ANALYSIS_SUGGESTIONS = true;

// ---------------------------------------------------------------------------
// Context files (files outside the diff, shown as line ranges)
// ---------------------------------------------------------------------------

/**
 * Whether changing the base branch of a Local review (the selector shown for
 * a stacked branch) puts comments, file-level comments and suggestions back
 * on the diff it re-renders.
 *
 * `false` is main (ledger H1): that path fetches and renders the new diff and
 * stops there. Every card is gone from the diff while the counts, which come
 * from data, still include them; the next comment or suggestion reload draws
 * them again. The other five whole-diff re-renders (whitespace, refresh,
 * scope) do put them back. `true` when a re-render keeps what is drawn on the
 * diff by construction.
 */
const BASE_CHANGE_KEEPS_CARDS = false;

/**
 * Where a context file sits in the diff pane relative to the changed files.
 *
 *   'interleaved'  by path among the changed files (the current behaviour)
 *   'after-diff'   after every changed file, sorted by path among themselves
 *                  (decision D2 of plans/codeview-virtualized-diff.md, if the
 *                  user accepts it)
 *
 * The position is the one context-file behaviour the migration may change on
 * purpose, so the expectation lives here and specs ask `expectedPaneOrder`.
 */
const CONTEXT_FILE_PLACEMENT = 'interleaved';

/**
 * The order in which the pane shows `diffFiles` (already in diff order) and
 * `contextFiles`, under the current placement.
 * @param {string[]} diffFiles
 * @param {string[]} contextFiles
 * @returns {Array<{file: string, kind: 'diff'|'context'}>}
 */
function expectedPaneOrder(diffFiles, contextFiles) {
  const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const context = contextFiles.slice().sort(byPath).map((file) => ({ file, kind: 'context' }));
  const diff = diffFiles.map((file) => ({ file, kind: 'diff' }));
  if (CONTEXT_FILE_PLACEMENT === 'after-diff') return [...diff, ...context];
  // Interleaved: each context file goes before the first file whose path
  // sorts after it (pr.js renderContextFile).
  const out = diff.slice();
  for (const entry of context) {
    const index = out.findIndex((other) => other.file > entry.file);
    if (index === -1) out.push(entry);
    else out.splice(index, 0, entry);
  }
  return out;
}

/** What a reader sees of a context file: header, displayed lines and ranges, gaps, cards. Null when absent. */
async function contextFileState(page, file) {
  return inPage(page, (D, f) => D.contextDump(f), file);
}

/** Locator of the row showing `line` of a context file. */
function contextLine(page, file, line) {
  return contextFile(page, file)
    .locator(`.d2h-diff-table tr[data-line-number="${line}"]:not(.context-expand-row)`);
}

/**
 * Click an expand control of the Nth gap (0-based, top to bottom) of a
 * context file.
 * @param {('up'|'down'|'all')} direction - must be one the gap offers
 *   (see contextFileState(...).gaps[n].directions)
 */
async function expandContextGap(page, file, gapIndex, direction) {
  const gap = contextFile(page, file).locator('.d2h-diff-table tr.context-expand-row').nth(gapIndex);
  const title = direction === 'all' ? 'Expand all' : direction === 'up' ? 'Expand up' : 'Expand down';
  await gap.locator(`.expand-button[title="${title}"]`).click();
}

/** Click the whole-gap control of the Nth gap ("N hidden lines"): reveals everything hidden there. */
async function expandContextGapFully(page, file, gapIndex) {
  await contextFile(page, file).locator('.d2h-diff-table tr.context-expand-row').nth(gapIndex)
    .locator('.clickable-expand').click();
}

/** Hover a context line and click its "add comment" control; waits for the form. */
async function openContextLineCommentForm(page, file, line) {
  const row = contextLine(page, file, line);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const button = row.locator('.add-comment-btn');
  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await contextFile(page, file).locator('.user-comment-form').waitFor({ state: 'visible', timeout: 5000 });
}

/** Locator of a context line's "chat about this line" control (visible on hover). */
function contextLineChatButton(page, file, line) {
  return contextLine(page, file, line).locator('.chat-line-btn');
}

// ---------------------------------------------------------------------------
// Standing checks and dumps
// ---------------------------------------------------------------------------

/**
 * A virtualized viewer must never leave a host element in the DOM that it no
 * longer accounts for (vendor fact F1). The current engine has one host per
 * rendered file and nothing to orphan, so today this only checks that no
 * file has two hosts.
 */
async function assertNoOrphanHosts(page) {
  const problems = await inPage(page, (D) => {
    const seen = new Map();
    for (const w of D.wrappers()) {
      if (w.classList.contains('context-file')) continue;
      const hosts = w.matches('diffs-container') ? 1 : w.querySelectorAll('diffs-container').length;
      const key = w.dataset.fileName;
      seen.set(key, (seen.get(key) || 0) + 1);
      if (hosts > 1) return [`${key}: ${hosts} hosts`];
    }
    return [...seen].filter(([, n]) => n > 1).map(([file, n]) => `${file}: ${n} wrappers`);
  });
  if (problems.length > 0) {
    throw new Error(`Orphan or duplicate diff hosts: ${problems.join('; ')}`);
  }
}

/** Everything visible of one diff file, as data (see D.dump). */
async function dumpFile(page, file) {
  return inPage(page, (D, f) => D.dump(f), file);
}

module.exports = {
  // selectors
  fileSelector,
  contextFileSelector,
  lineCardSelector,
  inAnnotationGroup,
  // files
  fileWrapper,
  contextFile,
  allFileWrappers,
  filesInPane,
  waitForDiffToRender,
  waitForFileRendered,
  rowCount,
  hasRenderedBody,
  // rows
  rows,
  rowsOfType,
  lineNumberCells,
  lineNumberCell,
  separators,
  expandableSeparators,
  expandControls,
  // annotations
  lineCards,
  annotationGroups,
  inlineComment,
  inlineSuggestion,
  expectAnnotationInColumn,
  annotationCell,
  // layout
  waitForDiffType,
  anyFileInSplitLayout,
  fileLayout,
  paintProbe,
  // upgrade / reveal
  waitForContentUpgrade,
  waitForFileSettled,
  ensureContentUpgrade,
  waitForHighlightedDisplay,
  upgradeAwaitingDisplay,
  contentsApplied,
  framesWithoutUpgrade,
  isLineVisible,
  revealOffHunkLine,
  hunkContaining,
  expandHunkBy,
  redisplayBaseDiff,
  holdWorkerResults,
  // pointer
  waitForDiffSettled,
  hoverDiffLine,
  openLineCommentForm,
  selectLineRange,
  lineSelection,
  gutterButtonsState,
  additionsContentPoint,
  scrollDiffUnderPointer,
  // scrolling
  scrollState,
  scrollDiffTo,
  scrollDiffToEdge,
  scrollThroughDiff,
  scrollFileIntoView,
  scrollFileOutOfView,
  headerPosition,
  headerLanding,
  firstFileBelowToolbar,
  firstVisibleRow,
  rowBox,
  selectedText,
  flashedLines,
  syntaxTokens,
  wrapInfo,
  clickExpandControl,
  parkPointerOnLine,
  // context files
  CONTEXT_FILE_PLACEMENT,
  LAYOUT_TOGGLE_KEEPS,
  UPGRADE_WAITS_FOR_FOCUS,
  DELETED_COMMENT_RETURNS_ON_RERENDER,
  CHAT_LINK_REACHES_UNRENDERED_FILE,
  REVEALED_LINE_KEEPS_FLASH,
  BASE_CHANGE_KEEPS_CARDS,
  THREAD_ADDED_WHILE_DIFF_AWAITS_DISPLAY,
  GUTTER_BUTTON_STAYS_WITH_ANALYSIS_SUGGESTIONS,
  expectedPaneOrder,
  contextFileState,
  contextLine,
  expandContextGap,
  expandContextGapFully,
  openContextLineCommentForm,
  contextLineChatButton,
  // checks and dumps
  assertNoOrphanHosts,
  dumpFile,
  inPage,
  waitInPage,
};
