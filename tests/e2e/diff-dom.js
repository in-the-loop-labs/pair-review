// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The diff pane, as E2E specs see it.
 *
 * THIS IS THE ONLY E2E FILE THAT KNOWS VENDOR DOM. A spec never names
 * `diffs-container`, a shadow root, or a vendor row
 * attribute (`data-line`, `data-column-number`, `data-separator`,
 * `data-expand-*`, `data-additions`, `data-diff-type`,
 * `data-annotation-slot`, ...), and never reaches for a vendor instance
 * through `prManager.pierreBridge`. It asks this module.
 * `tests/unit/e2e-vendor-dom-boundary.test.js` enforces that.
 *
 * Why: the diff pane is drawn by a vendor component (one virtualized
 * `CodeView` of @pierre/diffs, plans/codeview-virtualized-diff.md). When the
 * vendor's DOM changes, or the component is replaced again, this file and
 * its half change and the specs do not. That is how the migration to the
 * viewer was proven: every scenario ran unchanged on the renderer it
 * replaced and on the viewer.
 *
 * What a spec may still name, because the application owns it:
 * `.d2h-file-wrapper[data-file-name]` (the element that carries a file's
 * identity; its header, file-comment zone and cards are light-DOM
 * descendants), `.d2h-file-header`, card classes (`.user-comment-row`,
 * `.ai-suggestion`, ...), `.pierre-gutter-buttons` / `.pierre-comment-btn` /
 * `.pierre-chat-btn` (application elements), and `#diff-container`.
 *
 * The shape: a file's wrapper IS the vendor's `diffs-container` host, for
 * changed files and context files alike, with an open shadow root, and it
 * exists only while the viewer has the file mounted (near the viewport).
 * This file is the surface every spec imports: selectors, locators, the
 * waits, the named expectations. What has to know that a file may not be
 * mounted, the bridge's records and a context file's rows is in
 * tests/e2e/diff-dom-codeview.js, which extends the in-page library and
 * gives those helpers; they are exported here under one name.
 *  - Playwright CSS locators pierce open shadow roots, so
 *    `wrapper.locator('[data-line]')` reaches a file's rows.
 *
 * Timing rules (tests/CONVENTIONS.md):
 *  - A file's contents are fetched after its patch renders and the diff is
 *    upgraded with them. Rows are re-created by that upgrade. Wait for
 *    `waitForContentUpgrade` before measuring geometry or holding a row.
 *  - CSS transitions are ON. Poll for a settled value; never read once.
 */

// ---------------------------------------------------------------------------
// Selectors (vendor attribute names live here and nowhere else in tests/e2e)
// ---------------------------------------------------------------------------

const { expect, test } = require('@playwright/test');
const viewerHalf = require('./diff-dom-codeview.js');

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

  /**
   * Set the diff's scroll position the way a reader's own scrolling does.
   * (An engine half may have to let go of a navigation first: D.releaseScroll.)
   */
  D.setScrollTop = (top) => {
    const s = D.scroller();
    if (D.releaseScroll) D.releaseScroll();
    s.scrollTop = top;
    return s.scrollTop;
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

  // D.record, D.engineSettled, D.isDisplayCurrent, D.contentsTaken and
  // D.isUpgraded (what the bridge holds for a file, and whether what is on
  // screen is what it asked for) are defined by the viewer's half.

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
      notices: [...wrapper.querySelectorAll('.large-diff-placeholder')].map(text),
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

  /**
   * How far a file's code overflows horizontally (0 when every line wraps),
   * and its row heights.
   *
   * Per box, one of two questions. A box that scrolls (`overflow-x` auto,
   * scroll or hidden): how far it can be scrolled. A box that does not: how
   * far something sticks out of it, which is past its border. `scrollWidth`
   * is counted from the padding box, so a box's own right border is taken
   * off: on the virtualized viewer the file's frame is the code block's
   * border and the file's comment zone lies over it by design, as it does
   * over the frame on the per-file renderer (ledger H142); there the code
   * block has no border and the number is the one it always was.
   *
   * The boxes that do not scroll must stay in the list. An overflow that
   * leaves the code block without a box that scrolls never reaches the
   * pane's scroller on the virtualized viewer (layout containment on the way
   * up), so only the code block and the file report it.
   */
  D.wrapInfo = (file) => {
    const pre = D.pre(file);
    const wrapper = D.wrapper(file);
    if (!pre || !wrapper) return null;
    const scroller = D.scroller();
    const over = (el) => {
      if (!el) return 0;
      const style = getComputedStyle(el);
      const beyond = el.scrollWidth - el.clientWidth;
      const scrolls = /^(auto|scroll|hidden)$/.test(style.overflowX);
      return Math.max(0, scrolls ? beyond : beyond - (parseFloat(style.borderRightWidth) || 0));
    };
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

  /**
   * Record, from now on, every request the page makes to scroll something of
   * the diff pane into view, by the file it is for (null when it is for
   * nothing of a file). A request is a call of `scrollIntoView` on an
   * element of the pane, and on the virtualized viewer also a scroll target
   * given to the viewer (D.watchViewerScrollRequests).
   */
  D.watchScrollRequests = () => {
    if (D.scrollRequestLog) {
      D.scrollRequestLog.length = 0;
    } else {
      D.scrollRequestLog = [];
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function scrollIntoViewWatched(...args) {
        const pane = document.getElementById('diff-container');
        // Up through shadow roots: a row of the viewer is inside one.
        let owner = null;
        let inPane = false;
        for (let node = this; node; node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null) {
          if (node === pane) { inPane = true; break; }
          if (!owner && node.dataset && node.dataset.fileName) owner = node.dataset.fileName;
        }
        if (inPane) D.scrollRequestLog.push(owner);
        return original.apply(this, args);
      };
    }
    if (D.watchViewerScrollRequests) D.watchViewerScrollRequests(D.scrollRequestLog);
  };

  window.__diffDom = D;
}
/* eslint-enable no-undef */

/** What builds the in-page library: this file's, then the extension of it in the viewer's half. */
const IN_PAGE_INSTALLERS = [installInPage, viewerHalf.extendInPage];
const IN_PAGE_SOURCES = IN_PAGE_INSTALLERS.map((fn) => fn.toString());

async function lib(page) {
  for (const installer of IN_PAGE_INSTALLERS) await page.evaluate(installer);
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
  return page.waitForFunction(
    ({ source: s, installers, arg: inner }) => {
      if (!window.__diffDom) {
        // eslint-disable-next-line no-new-func
        for (const i of installers) new Function(`return (${i})`)()();
      }
      // eslint-disable-next-line no-new-func
      return new Function(`return (${s})`)()(window.__diffDom, inner);
    },
    { source, installers: IN_PAGE_SOURCES, arg },
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
/**
 * The diff pane's message: loading, an error, an empty diff. It is shown in
 * place of the diff, or above it when the diff is empty (context files stay
 * under it). A spec asks for the message here and never names where the
 * application puts it.
 */
function diffStatus(page) {
  return page.locator('#diff-status');
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
 * the viewport: a row that is in the DOM and hidden is not one a reader sees.
 */
async function rowCount(page, file) {
  return inPage(page, (D, f) => D.rows(f).filter((row) => row.getClientRects().length > 0).length, file);
}

/** Number of code rows in the document, over every file that is mounted (on screen or near it). */
async function mountedRowCount(page) {
  return inPage(page, (D) => D.hosts().reduce((sum, host) => sum + (host.shadowRoot ? host.shadowRoot.querySelectorAll('[data-content] > [data-line]').length : 0), 0));
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
 * The pane holds exactly `count` line cards of one annotation type, each
 * once. A statement about the pane, not about the document: the count is
 * taken from what the application holds for its files, and every file that
 * has an element shows exactly its own cards.
 *
 * On the per-file renderer a file keeps its element once drawn, so the
 * document holds every card and is counted too. A virtualized viewer has no
 * element for a file far from the viewport; there the document may hold
 * fewer cards, never more, and never one twice.
 * @param {string} cardSelector - e.g. '.hunk-summary-row'
 * @param {string} annotationType - the cards' annotation type, e.g. 'hunk-summary'
 */
async function expectLineCardsInPane(page, cardSelector, annotationType, count) {
  const read = () => inPage(page, (D, a) => {
    const bridge = window.prManager.pierreBridge;
    let held = 0;
    const mismatched = [];
    for (const file of bridge.files.keys()) {
      const own = bridge.getAnnotations(file, a.type).length;
      held += own;
      const wrapper = D.wrapper(file) || (D.contextWrapper ? D.contextWrapper(file) : null);
      if (!wrapper) continue;
      const drawn = wrapper.querySelectorAll(`${a.slot} > ${a.card}`).length;
      if (drawn !== own) mismatched.push(`${file}: ${drawn} drawn, ${own} held`);
    }
    return { held, mismatched, inDocument: document.querySelectorAll(`#diff-container ${a.slot} > ${a.card}`).length };
  }, { type: annotationType, card: cardSelector, slot: ANNOTATION_SLOT });
  await expect.poll(async () => {
    const state = await read();
    return { held: state.held, mismatched: state.mismatched };
  }).toEqual({ held: count, mismatched: [] });
  // Only the cards of mounted files are in the document.
  expect((await read()).inDocument).toBeLessThanOrEqual(count);
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
    // Changed files only: a context file is one column in either layout.
    const hosts = D.wrappers().filter((w) => !w.classList.contains('context-file')).map(D.hostOf).filter(Boolean);
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
 * every file below it: the row under a resting pointer is another row a
 * moment later, and a click goes to whatever is there by then (ledger H161;
 * on the per-file renderer this was the "subtree intercepts pointer events"
 * failures of comment-crud and comments-review in the phase 1 and 2 logs).
 */
async function waitForDiffSettled(page, { timeout = 15000 } = {}) {
  await waitInPage(page, (D) => D.upgradesIdle() && D.wrappers()
    .filter((w) => !w.classList.contains('context-file'))
    .every((w) => D.isDisplayCurrent(w.dataset.fileName)), null, { timeout });
}

/**
 * Wait until the pane, where it is now, shows what it is going to show.
 *
 * For a test that puts the pane somewhere with a script and then states
 * that the pane does not move. The viewer draws the files of a new place on
 * the frame after the scroll, their contents are asked for then and arrive
 * later, and a file that grows above the reader's line takes the pane's
 * scroll position with it: the viewer keeps that line where it is (ledger
 * H151). Measured 3,000 px into the sixty-file review: the position becomes
 * 3,122 when the contents are there. That is usually within the 0.3 s a
 * "has the position stopped changing" poll takes, and after it on a busy
 * machine: the pane was then seen 122 px further under a press that holds
 * nothing (scroll-landing.spec.js, once in 40).
 *
 * Waits until files are drawn from the toolbar down to the pane's bottom
 * edge (the viewer's pass for this place has run, and what it mounted is
 * queued for its contents), then for waitForDiffSettled.
 */
async function waitForPaneSettledInPlace(page, { timeout = 15000 } = {}) {
  await waitInPage(page, (D) => {
    const scroller = D.scroller();
    const top = D.pinnedBottom();
    const bottom = scroller.getBoundingClientRect().bottom;
    const atEnd = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
    const gap = D.viewerGap ? D.viewerGap() : 0;
    const boxes = D.wrappers().map((w) => ({
      top: w.getBoundingClientRect().top,
      // An entry and the space the pane keeps below it.
      reach: w.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(w).marginBottom) || 0) + gap,
    }));
    const inView = boxes.filter((box) => box.top < bottom && box.reach > top);
    if (inView.length === 0) return false;
    return atEnd || boxes.some((box) => box.reach >= bottom - 1);
  }, null, { timeout });
  await waitForDiffSettled(page, { timeout });
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
 * click the comment button that appears. Resolves when one more form is
 * open, on the line that was asked for.
 *
 * The comment button belongs to the row that is under the pointer when it is
 * clicked. Rows can move under a resting pointer between the hover and the
 * click (a card above the line gets its height a frame after it is attached,
 * a file's contents arrive), the browser then reports the row that is now
 * under the pointer, and the button is that row's: the click opens a form on
 * a neighbouring line, as it would for a reader. Seen about once in a
 * hundred executions of one test, on the per-file renderer's successor at
 * the phase-7 commit as well (ledger H161). So a form that opened on another
 * line is closed again and the gesture is repeated; a button that keeps
 * opening the wrong line fails here after the timeout.
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
  /** What each open form says of itself: file, first and last line, side. */
  const formKeys = () => forms.evaluateAll((elements) => elements.map((element) => {
    const textarea = element.querySelector('textarea');
    return textarea ? `${textarea.dataset.file}|${textarea.dataset.line}|${textarea.dataset.lineEnd}|${textarea.dataset.side}` : '';
  }));
  const known = await formKeys();
  const wantedSide = side === 'deletions' ? 'LEFT' : 'RIGHT';
  /** A form on the line: the line itself, or a selected range that holds it (the button of a line inside a selection comments the range). */
  const isOnLine = (key) => {
    const [, first, last, formSide] = key.split('|');
    return formSide === wantedSide && Number(first) <= Number(line) && Number(line) <= Number(last || first);
  };
  await expect(async () => {
    await page.mouse.move(0, 0);
    await cell.hover({ timeout: 2000 });
    // Seen, then clicked. The buttons are hidden while the pane moves (the
    // hover may have scrolled it); a click on a control that is not shown yet
    // makes Playwright scroll it elsewhere and take the line from under the pointer.
    await expect(scope.locator('.pierre-comment-btn').first()).toBeVisible({ timeout: 2000 });
    await scope.locator('.pierre-comment-btn').first().click({ timeout: 2000 });
    // The click opened a form. One that arrives in the frame after the file
    // was drawn again finds no button under the pointer (the hover is told
    // to the new rows a frame after a draw, on main as well) and opens
    // nothing: seen twice in some 500 executions of one describe (ledger,
    // phase 9 round 2). The gesture is made again, as a reader would.
    await expect(forms).toHaveCount(before + 1, { timeout: 2000 });
    if (!file) return;
    const opened = (await formKeys()).filter((key) => !known.includes(key));
    if (opened.length === 1 && isOnLine(opened[0])) return;
    // Another row's button took the click: close what it opened and start over.
    await forms.evaluateAll((elements, keep) => {
      for (const element of elements) {
        const textarea = element.querySelector('textarea');
        const key = textarea ? `${textarea.dataset.file}|${textarea.dataset.line}|${textarea.dataset.lineEnd}|${textarea.dataset.side}` : '';
        if (!keep.includes(key)) element.querySelector('.cancel-comment-btn')?.click();
      }
    }, known);
    await expect(forms).toHaveCount(before, { timeout: 2000 });
    throw new Error(`the comment button opened a form on ${opened.join(', ')}, not on line ${line} (${wantedSide}) of ${file}`);
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

/** Wait `count` animation frames of the page. */
async function animationFrames(page, count = 1) {
  await page.evaluate((n) => new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);
}

/** The bounding box of `locator` once it is the same in two frames running (null when it has none). */
async function steadyBox(page, locator, { timeout = 5000 } = {}) {
  const until = Date.now() + timeout;
  let box = await locator.boundingBox();
  while (box && Date.now() < until) {
    await animationFrames(page, 2);
    const again = await locator.boundingBox();
    if (again && Math.abs(again.x - box.x) < 0.5 && Math.abs(again.y - box.y) < 0.5) return again;
    box = again;
  }
  return box;
}

/**
 * Drag down or up the line-number column with a real pointer, from one line
 * to another, and report what the application selected. Unlike
 * selectLineRange, whatever the application makes of the drag is the
 * answer: a drag across lines the diff does not show stops at them (ledger
 * H184).
 *
 * The press must land on `from`. Rows can move under a resting pointer (a
 * file's contents or cards arriving, the pane settling after a scroll: seen
 * one row off on the first drag after a scroll), so the boxes are taken once
 * they are steady and the press is checked: when the application does not
 * report `from` alone on its side, the pointer is let go and the gesture is
 * made again, as a reader would.
 *
 * @param {Object} options
 * @param {string} options.file
 * @param {number} options.from - the line the drag starts on
 * @param {number} options.to - the line the pointer is let go on
 * @param {('additions'|'deletions')} [options.side='additions'] - of `from`:
 *   its column in split layout, deleted or other row in unified layout
 * @param {('additions'|'deletions')} [options.toSide=side] - of `to`
 * @param {boolean} [options.context=false] - `file` is a context file
 * @param {boolean} [options.waitForUpgrade] - default: not for a context
 *   file; false for a file whose contents are held by the test
 * @param {Function} [options.whileHeld] - async () => void, run with the
 *   pointer held on `to`, before the release
 * @returns {Promise<{held: Object|null, released: Object|null}>} the
 *   application's selection (lineSelection) with the pointer held on `to`,
 *   and after the release
 */
async function dragLineNumbers(page, { file, from, to, side = 'additions', toSide = side, context = false, waitForUpgrade = !context, whileHeld }) {
  const scope = context ? contextFile(page, file) : fileWrapper(page, file);
  const cellFor = (line, s) => lineNumberCell(scope, line, { side: s }).first();
  if (waitForUpgrade) await waitForContentUpgrade(page, file);
  const pressedSide = sideColumn(side) === 'deletions' ? 'LEFT' : 'RIGHT';
  let result = null;
  await expect(async () => {
    await cellFor(from, side).scrollIntoViewIfNeeded({ timeout: 2000 });
    const a = await steadyBox(page, cellFor(from, side));
    const b = await steadyBox(page, cellFor(to, toSide));
    if (!a || !b) throw new Error(`dragLineNumbers: lines ${from} and ${to} of ${file} must both be on screen`);
    await page.mouse.move(a.x + 6, a.y + a.height / 2);
    await page.mouse.down();
    const outcome = {};
    try {
      const pressed = await lineSelection(page, file);
      if (!pressed || pressed.start !== from || pressed.end !== from || pressed.side !== pressedSide) {
        throw new Error(`dragLineNumbers: the press meant for line ${from} (${pressedSide}) selected ${JSON.stringify(pressed)}`);
      }
      await page.mouse.move(b.x + 6, b.y + b.height / 2, { steps: 12 });
      await animationFrames(page, 2);
      outcome.held = await lineSelection(page, file);
      if (whileHeld) await whileHeld();
    } finally {
      await page.mouse.up();
    }
    outcome.released = await lineSelection(page, file);
    result = outcome;
  }).toPass({ timeout: 15000 });
  return result;
}

/**
 * Shift-click a line number: the gesture that extends the selection there
 * is to the clicked line. Returns the application's selection afterwards.
 * @param {Object} options - `{file, line, side}` as for dragLineNumbers
 */
async function shiftClickLineNumber(page, { file, line, side = 'additions' }) {
  const box = await steadyBox(page, lineNumberCell(fileWrapper(page, file), line, { side }).first());
  if (!box) throw new Error(`shiftClickLineNumber: line ${line} of ${file} must be on screen`);
  await page.keyboard.down('Shift');
  try {
    await page.mouse.click(box.x + 6, box.y + box.height / 2);
  } finally {
    await page.keyboard.up('Shift');
  }
  return lineSelection(page, file);
}

/**
 * Drag that starts on the comment button of the gutter (the application's
 * own drag, `wrapButton` in pierre-gutter.js): point at `from`'s number,
 * press on the button that appears, drag to `to`'s number, let go. The
 * vendor limits it to two lines (ledger H45, H130). Made again when the
 * button was another row's (the selection then holds neither `from` as an
 * end nor nothing).
 * @returns {Promise<{held: Object|null, released: Object|null}>}
 */
async function dragFromCommentButton(page, { file, from, to }) {
  const scope = fileWrapper(page, file);
  let result = null;
  await expect(async () => {
    await clearSelection(page, file);
    await page.mouse.move(0, 0);
    const fromCell = lineNumberCell(scope, from, { side: 'additions' }).first();
    await fromCell.scrollIntoViewIfNeeded({ timeout: 2000 });
    await fromCell.hover({ timeout: 2000 });
    const button = scope.locator('.pierre-comment-btn').first();
    await expect(button).toBeVisible({ timeout: 2000 });
    const a = await steadyBox(page, button);
    const b = await steadyBox(page, lineNumberCell(scope, to, { side: 'additions' }).first());
    if (!a || !b) throw new Error(`dragFromCommentButton: the button and line ${to} must be on screen`);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    const outcome = {};
    try {
      await page.mouse.move(a.x + a.width / 2, b.y + b.height / 2, { steps: 12 });
      await animationFrames(page, 2);
      outcome.held = await lineSelection(page, file);
    } finally {
      await page.mouse.up();
    }
    outcome.released = await lineSelection(page, file);
    const s = outcome.released;
    if (s && s.start !== from && s.end !== from) {
      throw new Error(`dragFromCommentButton: the button was another row's (selection ${JSON.stringify(s)}, from ${from})`);
    }
    result = outcome;
  }).toPass({ timeout: 15000 });
  return result;
}

/** Clear the line selection of `file`, if it has one. */
async function clearSelection(page, file) {
  await page.evaluate((f) => window.prManager.pierreBridge.clearLineSelection(f), file);
}

/**
 * Start recording which rows of `file` are highlighted as selected: at every
 * microtask checkpoint at which the set changed (nothing can be painted
 * between two of them) and at every animation frame, until
 * selectedRowsWatched. One watch per page at a time.
 */
async function watchSelectedRows(page, file) {
  await inPage(page, (D, f) => {
    const rootOf = () => {
      const host = D.hostOf(D.wrapper(f) || D.contextWrapper(f));
      return (host && host.shadowRoot) || null;
    };
    const highlighted = () => {
      const pre = rootOf() && rootOf().querySelector('pre[data-diff-type]');
      if (!pre) return [];
      return [...pre.querySelectorAll('[data-column-number][data-selected-line]')].map((cell) => {
        const code = cell.closest('code');
        const deletion = code.hasAttribute('data-deletions')
          || (!code.hasAttribute('data-additions') && cell.getAttribute('data-line-type') === 'change-deletion');
        return { side: deletion ? 'LEFT' : 'RIGHT', line: Number(cell.getAttribute('data-column-number')) };
      });
    };
    const watch = { states: [], stopped: false, last: null };
    const note = () => {
      const state = highlighted();
      const key = JSON.stringify(state);
      if (key !== watch.last) { watch.states.push(state); watch.last = key; }
    };
    watch.observer = new MutationObserver(note);
    // The file's rows can be drawn again (its contents arriving): observed from its root down.
    const observe = () => { const root = rootOf(); if (root) watch.observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-selected-line'] }); };
    observe();
    const frame = () => {
      if (watch.stopped) return;
      observe();
      note();
      requestAnimationFrame(frame);
    };
    note();
    requestAnimationFrame(frame);
    window.__selectedRowsWatch = watch;
  }, file);
}

/**
 * Stop the watch of watchSelectedRows (after two more frames) and return
 * what it saw: each state a list of `{side: 'LEFT'|'RIGHT', line}`, in order.
 */
async function selectedRowsWatched(page) {
  return page.evaluate(async () => {
    const watch = window.__selectedRowsWatch;
    if (!watch) throw new Error('selectedRowsWatched: no watch (call watchSelectedRows first)');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    watch.stopped = true;
    watch.observer.disconnect();
    delete window.__selectedRowsWatch;
    return watch.states;
  });
}

/**
 * The line whose number cell the visible gutter buttons of `file` sit in,
 * by where they are drawn: `{line, side}`, or null when none is shown.
 */
async function gutterButtonsLine(page, file) {
  return inPage(page, (D, f) => {
    const wrapper = D.wrapper(f) || D.contextWrapper(f);
    const host = D.hostOf(wrapper);
    if (!wrapper || !host || !host.shadowRoot) return null;
    const shown = [...wrapper.querySelectorAll('.pierre-gutter-buttons')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    });
    if (!shown) return null;
    const r = shown.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const x = r.left + r.width / 2;
    const cell = [...host.shadowRoot.querySelectorAll('[data-column-number]')].find((c) => {
      const b = c.getBoundingClientRect();
      return b.height > 0 && y >= b.top && y < b.bottom && x >= b.left - 1 && x <= b.right + 1;
    });
    if (!cell) return null;
    const code = cell.closest('code');
    const deletion = code.hasAttribute('data-deletions')
      || (!code.hasAttribute('data-additions') && cell.getAttribute('data-line-type') === 'change-deletion');
    return { line: Number(cell.getAttribute('data-column-number')), side: deletion ? 'LEFT' : 'RIGHT' };
  }, file);
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
    return D.setScrollTop(before < max ? max : 0) !== before;
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

/**
 * Start noting, in every frame the page draws, whether each of `lines` of a
 * context file has its row in the document (see contextLinesWatched). What a
 * spec asks when it has to say "these lines stayed on screen throughout":
 * a read before and a read after cannot see a line that left for a few
 * frames and came back. A page navigation ends the watch.
 */
async function watchContextLines(page, file, lines) {
  await inPage(page, (D, a) => {
    if (D.contextLineWatch) D.contextLineWatch.stopped = true;
    const watch = D.contextLineWatch = { frames: 0, framesWithout: [], stopped: false };
    const tick = () => {
      if (watch.stopped) return;
      watch.frames += 1;
      if (!a.lines.every((line) => !!D.contextLineRow(a.file, line))) watch.framesWithout.push(watch.frames);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { file, lines });
}

/**
 * End the watch started by watchContextLines, after the next frame: the
 * state the page is in when this is called is always among the frames seen
 * (the watch's own callback for that frame was registered first and runs
 * first).
 * @returns {Promise<{frames: number, framesWithout: number[]}>} how many
 *   frames were seen, and which of them lacked a row of a watched line
 */
async function contextLinesWatched(page) {
  return inPage(page, async (D) => {
    const watch = D.contextLineWatch;
    if (!watch) return null;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    watch.stopped = true;
    return { frames: watch.frames, framesWithout: watch.framesWithout.slice() };
  });
}

/**
 * Start recording the page's requests to scroll something of the diff pane
 * into view (see scrollRequests). A page navigation ends the recording.
 */
async function watchScrollRequests(page) {
  await inPage(page, (D) => { D.watchScrollRequests(); });
}

/**
 * The file each request to scroll the diff pane was for, in the order the
 * page made them since watchScrollRequests. What a spec asks when it has to
 * say "this click went nowhere" without waiting to see nothing happen: it
 * makes the same click on something that does go somewhere, and looks at
 * what was asked for by the time that request is there.
 */
async function scrollRequests(page) {
  return inPage(page, (D) => (D.scrollRequestLog || []).slice());
}

/** Set the diff's scroll position directly (no smooth scrolling). */
async function scrollDiffTo(page, top) {
  await inPage(page, (D, t) => { D.setScrollTop(t); }, top);
}

/** Scroll the diff to its very top or very bottom, by real scrolling of the scroll container. */
async function scrollDiffToEdge(page, edge) {
  await inPage(page, (D, e) => {
    D.setScrollTop(e === 'bottom' ? D.scroller().scrollHeight : 0);
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
 * viewport heights away), toward whichever end of the diff has room. The
 * virtualized viewer unmounts the file then: it has no element until the
 * reader comes back. A user would say "I scrolled far away from it".
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
    D.setScrollTop(target);
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

// --- collapse landings: begin ------------------------------------------------
// What collapse-scroll-anchor.spec.js and collapse-landing.spec.js ask. Written
// with the in-page library's scroller, file wrappers and pinned toolbar only
// (and, in ensureContentUpgrades, one method of the application's), which
// every renderer this module has stood in front of has had: the block runs
// unchanged against the application before the virtualized viewer.

/**
 * Where the entry a selector names is, as a reader sees it. Positions are
 * measured from the bottom of the toolbar pinned above the diff.
 * @param {string} wrapperSelector - a file's wrapper (changed file or context file)
 * @returns {Promise<{mounted: boolean, headerTop: number|null, headerBottomInViewport: boolean|null,
 *   stuck: boolean|null, gapBelow: number|null, spacing: number|null, collapsed: boolean|null,
 *   scrollTop: number, maxScrollTop: number}>} `stuck`: the entry starts above its header (the header is
 *   held at the toolbar); `gapBelow`: px to the entry drawn directly below, null when none is drawn;
 *   `spacing`: the space the pane keeps below an entry (its margin, or the viewer's gap between two entries)
 */
async function entryPlace(page, wrapperSelector) {
  return inPage(page, (D, selector) => {
    const scroller = D.scroller();
    const pane = { scrollTop: scroller.scrollTop, maxScrollTop: scroller.scrollHeight - scroller.clientHeight };
    const wrapper = document.querySelector(selector);
    const header = wrapper && wrapper.querySelector('.d2h-file-header');
    if (!header) {
      return {
        mounted: false, headerTop: null, headerBottomInViewport: null, stuck: null, gapBelow: null, spacing: null, collapsed: null, ...pane,
      };
    }
    const box = wrapper.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    // The entry drawn directly below, by position: a virtualized pane does
    // not keep its entries in pane order in the document.
    const below = D.wrappers()
      .filter((other) => other !== wrapper && other.getBoundingClientRect().top >= box.bottom - 0.5)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    return {
      mounted: true,
      headerTop: headerBox.top - D.pinnedBottom(),
      headerBottomInViewport: headerBox.bottom <= window.innerHeight,
      stuck: box.top < headerBox.top,
      gapBelow: below ? below.getBoundingClientRect().top - box.bottom : null,
      spacing: (parseFloat(getComputedStyle(wrapper).marginBottom) || 0) + (D.viewerGap ? D.viewerGap() : 0),
      collapsed: wrapper.classList.contains('collapsed'),
      ...pane,
    };
  }, wrapperSelector);
}

/** The distance from the bottom of an entry to the top of the entry drawn directly below it, in px (entryPlace). */
async function gapBelowFile(page, wrapperSelector) {
  return (await entryPlace(page, wrapperSelector)).gapBelow;
}

/** The space the pane keeps below an entry before the next one, in px (entryPlace). */
async function spacingBelowFile(page, wrapperSelector) {
  return (await entryPlace(page, wrapperSelector)).spacing;
}

/**
 * Scroll the pane, the way a reader's own scrolling does, to a place given
 * relative to an entry that has an element:
 *   { halfway: true }       half the entry's height into it (its header is stuck)
 *   { inside: n }           n px into it, measured at the toolbar's bottom edge
 *   { fromBottom: n }       the entry ends n px below the toolbar (its last rows push the header up)
 *   { headerAt: n }         its header is n px below the toolbar (not stuck)
 *   { headerMidPane: true } its header is half the scroll container's height below the container's top
 * @param {string} wrapperSelector
 */
async function scrollPaneToEntry(page, wrapperSelector, where) {
  await inPage(page, (D, a) => {
    const scroller = D.scroller();
    const wrapper = document.querySelector(a.selector);
    const box = wrapper.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const line = D.pinnedBottom();
    let by;
    if (a.where.halfway) by = (box.top - view.top) + wrapper.offsetHeight / 2;
    else if (a.where.inside != null) by = (box.top - line) + a.where.inside;
    else if (a.where.fromBottom != null) by = (box.bottom - line) - a.where.fromBottom;
    else if (a.where.headerAt != null) by = (box.top - line) - a.where.headerAt;
    else by = wrapper.querySelector('.d2h-file-header').getBoundingClientRect().top - view.top - scroller.clientHeight / 2;
    D.setScrollTop(scroller.scrollTop + by);
  }, { selector: wrapperSelector, where });
}

/**
 * Note the place of an entry's header in every frame the page draws from
 * now on, read after the frame's rendering, in a task of its own. The
 * function returned stops the watch and gives the samples: px below the
 * toolbar, or null for a frame in which the entry had no element.
 * @param {string} wrapperSelector
 * @returns {Promise<function(): Promise<Array<number|null>>>}
 */
async function watchEntryHeader(page, wrapperSelector) {
  await inPage(page, (D, selector) => {
    const watch = { samples: [], stopped: false };
    window.__entryHeaderWatch = watch;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (watch.stopped) return;
      const wrapper = document.querySelector(selector);
      const header = wrapper && wrapper.querySelector('.d2h-file-header');
      watch.samples.push(header ? header.getBoundingClientRect().top - D.pinnedBottom() : null);
      requestAnimationFrame(() => channel.port2.postMessage(0));
    };
    requestAnimationFrame(() => channel.port2.postMessage(0));
  }, wrapperSelector);
  return () => page.evaluate(() => {
    window.__entryHeaderWatch.stopped = true;
    return window.__entryHeaderWatch.samples;
  });
}

/**
 * Note, in every frame the page draws from now on (read after the frame's
 * rendering, in a task of its own), whether the pane shows a hole: a point
 * 40 px below the toolbar or one halfway down the pane that no entry (with
 * the space the pane keeps below it) covers. A reader sees a hole as no
 * file in view at all, or a file ending near the top with nothing below it.
 * The function returned stops the watch and gives the count of frames and
 * of frames with a hole.
 * @returns {Promise<function(): Promise<{frames: number, holes: number}>>}
 */
async function watchPaneHoles(page) {
  await inPage(page, (D) => {
    const watch = { frames: 0, holes: 0, stopped: false };
    window.__paneHoleWatch = watch;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (watch.stopped) return;
      const scroller = D.scroller();
      const top = D.pinnedBottom();
      const bottom = scroller.getBoundingClientRect().bottom;
      const gap = D.viewerGap ? D.viewerGap() : 0;
      const boxes = D.wrappers().map((w) => {
        const box = w.getBoundingClientRect();
        return { top: box.top, reach: box.bottom + (parseFloat(getComputedStyle(w).marginBottom) || 0) + gap };
      });
      const covered = (y) => boxes.some((box) => box.top <= y && box.reach >= y);
      watch.frames++;
      if (!covered(top + 40) || !covered((top + bottom) / 2)) watch.holes++;
      requestAnimationFrame(() => channel.port2.postMessage(0));
    };
    requestAnimationFrame(() => channel.port2.postMessage(0));
  });
  return () => page.evaluate(() => {
    window.__paneHoleWatch.stopped = true;
    return { frames: window.__paneHoleWatch.frames, holes: window.__paneHoleWatch.holes };
  });
}

/**
 * Collapse (or expand) a file through what its chevron calls, and read where
 * its header is in the same page task, before the page draws a frame.
 * @param {string} file - the file's path
 * @param {string} wrapperSelector - its wrapper
 * @returns {Promise<{mounted: boolean, headerTop: number|null, collapsed: boolean|null}>}
 */
async function toggleCollapseAndPlaceInOneTask(page, file, wrapperSelector) {
  return inPage(page, (D, a) => {
    window.prManager.toggleFileCollapse(a.file);
    const wrapper = document.querySelector(a.selector);
    const header = wrapper && wrapper.querySelector('.d2h-file-header');
    return {
      mounted: !!header,
      headerTop: header ? header.getBoundingClientRect().top - D.pinnedBottom() : null,
      collapsed: wrapper ? wrapper.classList.contains('collapsed') : null,
    };
  }, { file, selector: wrapperSelector });
}

/**
 * Give each of `files` its full contents now, through what the application
 * calls for a file a navigation reveals a line of
 * (`_ensurePierreContentUpgrade`, which the application before the
 * virtualized viewer has too), and wait: resolves when each has them or
 * cannot have them.
 *
 * In the background a file is given its contents only once the viewer has
 * drawn it, so after a navigation over many files, which of the files passed
 * on the way hold their contents is left to which frames the animated scroll
 * happened to draw. A test that measures to less than a pixel below those
 * files decides it instead (readFile in collapse-landing.spec.js). On a pane
 * that draws every file, every file gets them anyway.
 * @param {string[]} files - paths of changed files
 */
async function ensureContentUpgrades(page, files) {
  return page.evaluate((list) => Promise.all(list.map((f) => window.prManager._ensurePierreContentUpgrade(f))), files);
}

/**
 * Tick or clear the "Viewed" box of a file's header, and wait until the box
 * shows that. Not `locator.check()`.
 *
 * The header is something the page put into a file, and the viewer takes it
 * out of the document and puts it back with every draw of that file. When a
 * draw falls between a press and its release the browser sends no click, and
 * the bridge makes the click itself in a task of its own right after the
 * release (PierreBridge._handlePointerUp, ledger H140): the box is ticked and
 * the file collapses, one task later than a click the browser sends.
 * `check()` reads the box the moment its release has been handled, finds it
 * unchanged, and throws "Clicking the checkbox did not change its state" on
 * a page that goes on to do what was asked (measured with a draw forced into
 * the press: 29 of 240 checks threw, and in all 240 the box was ticked and
 * the file collapsed with its header in place; the scroll a test makes just
 * before is what draws the file, 1 time in 2,000 under load). A click and a
 * wait for the box state the same thing without the race.
 *
 *  {import('@playwright/test').Locator} entry - the file's entry (its wrapper)
 *  {boolean} [viewed=true]
 */
async function setViewedBox(entry, viewed = true) {
  const box = entry.locator('.file-viewed-checkbox');
  if ((await box.isChecked()) !== viewed) await box.click();
  await expect(box).toBeChecked({ checked: viewed });
}
// --- collapse landings: end --------------------------------------------------

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

/**
 * Change how the lines of a file that is on screen are laid out, in the page
 * only (the application always wraps): what `wrapInfo` must be able to see.
 *  - 'scroll': lines are not wrapped and the code column scrolls sideways
 *    (the vendor's other layout);
 *  - 'spill': lines are not wrapped and no column scrolls or clips, so the
 *    long line leaves the code block;
 *  - 'wrap': as the application draws it.
 * Resolves two frames later, when the layout has followed.
 */
async function setLineLayout(page, file, layout) {
  await inPage(page, async (D, a) => {
    const pre = D.pre(a.file);
    if (!pre) throw new Error(`setLineLayout: ${a.file} is not rendered`);
    const root = pre.getRootNode();
    const MARK = 'data-test-line-layout';
    root.querySelector(`style[${MARK}]`)?.remove();
    pre.setAttribute('data-overflow', a.layout === 'wrap' ? 'wrap' : 'scroll');
    if (a.layout === 'spill') {
      const style = document.createElement('style');
      style.setAttribute(MARK, '');
      style.textContent = 'pre[data-diff] > code { overflow: visible !important; contain: none !important; }';
      root.appendChild(style);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { file, layout });
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
 * Click `control` once, and say whether the browser sent the click.
 *
 * A browser sends no `click` when the pressed element was replaced between
 * the press and the release, and every draw of a file re-creates its rows
 * and separators (ledger H43, H143; main loses the click the same way).
 * Playwright reports such a click as made. And a file is drawn once more
 * after it reports settled: measured after `waitForContentUpgrade` and
 * `waitForDiffSettled`, the rows of a changed file were replaced 19 to 54 ms
 * later in 12 of 12 loads (30 to 74 ms later on main at 3223ecce, 12 of 12),
 * and a context file is drawn again about 0.13 s after a range was added to
 * it. So "the click was made" is read from the page: a trusted `click` event
 * arrived, anywhere, since the press.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} control
 * @param {Object} [options] - Playwright's click options
 * @returns {Promise<boolean>} whether the page received the click
 */
async function clickOnce(page, control, options = {}) {
  await page.evaluate(() => {
    if (!window.__diffDomClicks) {
      window.__diffDomClicks = { seen: 0 };
      window.addEventListener('click', (event) => { if (event.isTrusted) window.__diffDomClicks.seen++; }, { capture: true });
    }
    window.__diffDomClicks.seen = 0;
  });
  await control.click({ timeout: 2000, ...options });
  const arrived = await page.evaluate(() => window.__diffDomClicks.seen > 0);
  if (!arrived) noteLostClick(control);
  return arrived;
}

let lostClicks = 0;

/**
 * Count a click the browser did not send (clickOnce), and say so where a
 * reader of the run sees it: one line in the run's output, and a
 * `lost-click` annotation on the test, which the HTML and JSON reports
 * show. Every caller of clickOnce makes such a click again, so a test passes
 * however many were lost; the count is what shows a rise.
 *
 *   grep -c '\[diff-dom\] lost click' <the run's log>
 * @param {import('@playwright/test').Locator} control
 */
function noteLostClick(control) {
  lostClicks++;
  let where = 'outside a test';
  try {
    const info = test.info();
    where = info.titlePath.join(' > ');
    info.annotations.push({ type: 'lost-click', description: `the browser sent no click to ${control}; the click was made again` });
  } catch { /* not called from a test: the line below is all there is */ }
  console.log(`[diff-dom] lost click (${lostClicks} in this worker): the browser sent no click to ${control}; made again. ${where}`);
}

/** How many clicks the browser did not send in this worker process so far (noteLostClick). */
function lostClickCount() {
  return lostClicks;
}

/**
 * Click a control of the viewer's (an expand control, a gap's bar) and make
 * the click again for as long as the browser sends none (see clickOnce).
 * Nothing the application did is asserted or retried here: a click that
 * arrived is never made twice. Every click made again is counted and
 * reported (noteLostClick).
 */
async function clickDelivered(page, control, options = {}) {
  await expect(async () => {
    if (!(await clickOnce(page, control, options))) {
      throw new Error('the browser sent no click: the pressed element was replaced between the press and the release');
    }
  }).toPass({ timeout: 10000 });
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
  // again, whether Playwright says so (it throws) or not (clickOnce).
  await clickDelivered(page, expandControls(separator, direction).first());
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
 * What the console shows when the highlight worker's script cannot load and
 * highlighting falls back to the main thread: the vendor's `Worker error`
 * line, and the pool's report of the worker it lost. The same viewer goes on
 * highlighting on the main thread.
 */
const WORKER_LOAD_FAILURE_ERROR =
  /\[console\.error\] (Worker error: Event|WorkerPoolWorkerError: WorkerPoolManager: worker failed: the worker script failed to load)/;

/**
 * Whether the block the suggestion button inserts into a comment form holds
 * an empty line after the code.
 *
 *   true   "```suggestion\n<the line>\n\n```": the line's text as the diff
 *          holds it ends in a newline and the block's template adds its own.
 *          A defect the application had before the migration to the viewer
 *          (ledger H52), on main too.
 *   false  the code is followed by the closing fence at once: each line
 *          loses its line ending before the lines are joined (ledger H181,
 *          the review fixes of PR #646; vendor fact F32).
 */
const SUGGESTION_BLOCK_HAS_EMPTY_LINE = false;

// ---------------------------------------------------------------------------
// Context files (files outside the diff, shown as line ranges)
// ---------------------------------------------------------------------------

/**
 * Whether changing the base branch of a Local review (the selector shown for
 * a stacked branch) puts comments, file-level comments and suggestions back
 * on the diff it re-renders.
 *
 * `false` is what the application did before the migration to the viewer
 * and still does (ledger H1): that path fetches and renders the new diff and
 * stops there. Every card is gone from the diff while the counts, which come
 * from data, still include them; the next comment or suggestion reload draws
 * them again. The other five whole-diff re-renders (whitespace, refresh,
 * scope) do put them back. `true` when a re-render keeps what is drawn on the
 * diff by construction.
 */
const BASE_CHANGE_KEEPS_CARDS = false;

/**
 * A context file shows the lines themselves where five lines or fewer are
 * hidden (before its first range, after its last, or between two ranges):
 * the rule the viewer has for the gaps of a changed file applies to a
 * context file too (decision D2). `expectedContextRanges` turns the ranges a
 * scenario asked for into the ranges the pane shows.
 */
const SMALL_CONTEXT_GAP_LINES = 5;

/** The label of a hidden gap of `n` lines of a context file (the viewer's separator). */
function contextGapLabel(n) {
  return `${n} unmodified line${n === 1 ? '' : 's'}`;
}

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
  // Interleaved: each context file goes before the first file whose path
  // sorts after it (pr.js _buildPaneEntries).
  const out = diff.slice();
  for (const entry of context) {
    const index = out.findIndex((other) => other.file > entry.file);
    if (index === -1) out.push(entry);
    else out.splice(index, 0, entry);
  }
  return out;
}

/**
 * The ranges of lines a context file of `totalLines` lines shows for the
 * ranges a scenario asked for, under the small-gap rule.
 * @param {Array<{start: number, end: number}>} ranges - ascending, disjoint
 * @param {number} totalLines
 * @returns {Array<{start: number, end: number}>}
 */
function expectedContextRanges(ranges, totalLines) {
  const out = [];
  for (const range of ranges) {
    const last = out[out.length - 1];
    if (last && range.start - last.end - 1 <= SMALL_CONTEXT_GAP_LINES) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  if (out.length > 0) {
    if (out[0].start - 1 <= SMALL_CONTEXT_GAP_LINES) out[0].start = 1;
    const last = out[out.length - 1];
    if (totalLines - last.end <= SMALL_CONTEXT_GAP_LINES) last.end = totalLines;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Standing checks and dumps
// ---------------------------------------------------------------------------

// The viewer's half: the helpers that must not assume a file is mounted, the
// bridge's records and the context-file helpers, under the names specs use.
const viewerAdapter = viewerHalf.createCodeViewAdapter(
  { inPage, waitInPage, contextFile, fileWrapper, waitForContentUpgrade, clickOnce }
);

module.exports = {
  // what a development-bundle run needs (tests/e2e/fixtures.js)
  layoutValidator: viewerHalf.layoutValidator,
  // the standing check of every test: problems with the pane's hosts when a
  // test ends (assertNoOrphanHosts is the same check where a spec asks)
  orphanHostsAtEnd: viewerHalf.orphanHostsOf,
  // selectors
  fileSelector,
  contextFileSelector,
  lineCardSelector,
  inAnnotationGroup,
  expectLineCardsInPane,
  // files
  fileWrapper,
  contextFile,
  allFileWrappers,
  diffStatus,
  waitForDiffToRender,
  waitForFileRendered,
  rowCount,
  mountedRowCount,
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
  ensureContentUpgrades,
  setViewedBox,
  waitForHighlightedDisplay,
  upgradeAwaitingDisplay,
  contentsApplied,
  framesWithoutUpgrade,
  isLineVisible,
  revealOffHunkLine,
  holdWorkerResults,
  // pointer
  waitForDiffSettled,
  waitForPaneSettledInPlace,
  hoverDiffLine,
  openLineCommentForm,
  selectLineRange,
  dragLineNumbers,
  shiftClickLineNumber,
  dragFromCommentButton,
  watchSelectedRows,
  selectedRowsWatched,
  gutterButtonsLine,
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
  // collapse landings
  entryPlace,
  gapBelowFile,
  spacingBelowFile,
  scrollPaneToEntry,
  watchEntryHeader,
  watchPaneHoles,
  toggleCollapseAndPlaceInOneTask,
  firstFileBelowToolbar,
  watchScrollRequests,
  scrollRequests,
  watchContextLines,
  contextLinesWatched,
  firstVisibleRow,
  rowBox,
  selectedText,
  flashedLines,
  syntaxTokens,
  wrapInfo,
  setLineLayout,
  clickExpandControl,
  clickDelivered,
  lostClickCount,
  parkPointerOnLine,
  // named expectations and context files
  WORKER_LOAD_FAILURE_ERROR,
  BASE_CHANGE_KEEPS_CARDS,
  SUGGESTION_BLOCK_HAS_EMPTY_LINE,
  contextGapLabel,
  expectedContextRanges,
  expectedPaneOrder,
  inPage,
  waitInPage,
  // from the viewer's half: filesInPane, ensureMounted, the context-file
  // helpers, hunkContaining, expandHunkBy, redisplayBaseDiff, redrawFile,
  // assertNoOrphanHosts, dumpFile, layoutValidatorState
  ...viewerAdapter.overrides,
};
