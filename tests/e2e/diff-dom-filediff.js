// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The diff pane as E2E specs see it, on the default engine (one `FileDiff`
 * per changed file): the part that this engine does its own way.
 *
 * This is an engine half of tests/e2e/diff-dom.js, which selects it unless
 * the suite runs with PR_ENGINE=codeview and exports what it gives under the
 * names every spec imports. Changed files are read by diff-dom.js itself on
 * this engine; what is here is the context files, which the application's
 * table renderer draws: one `<tr>` per line in
 * `div.d2h-file-wrapper.context-file`, gap rows with expand buttons, cards
 * as rows. No shadow DOM.
 *
 * The table renderer, and this file with it, goes when the virtualized
 * viewer becomes the only engine (phase 8 of
 * plans/codeview-virtualized-diff.md).
 */

const { expect } = require('@playwright/test');

/**
 * Extends the in-page library of diff-dom.js (`window.__diffDom`) for this
 * engine. Runs in the page, after diff-dom.js's own installer.
 */
/* eslint-disable no-undef */
function extendInPage() {
  const D = window.__diffDom;
  if (!D || D.engine === 'filediff') return;
  D.engine = 'filediff';

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

  /** How a context file's lines are laid out: how many columns of code, and how wide they are in the file's element. */
  D.contextLayout = (file) => {
    const w = D.contextWrapper(file);
    const table = w && w.querySelector('.d2h-diff-table');
    if (!table) return null;
    return { columns: 1, codeWidth: table.getBoundingClientRect().width, fileWidth: w.clientWidth };
  };
}
/* eslint-enable no-undef */

/**
 * The Node side of this engine.
 * @param {Object} base - what diff-dom.js has for both engines: inPage,
 *   contextFile
 * @returns {Object} the context-file helpers under the names diff-dom.js
 *   exports
 */
function createFileDiffAdapter(base) {
  const { inPage, contextFile } = base;

  /**
   * The pane shows this context file, once. (A virtualized viewer keeps a file
   * that is far from the viewport out of the DOM, so "is in the pane" is not
   * "has an element" there; a spec asks this and not a locator's count.)
   */
  async function expectContextFile(page, file) {
    await expect(contextFile(page, file)).toHaveCount(1);
    await expect(contextFile(page, file)).toBeVisible();
  }

  /** The pane shows no such context file. */
  async function expectNoContextFile(page, file) {
    await expect(contextFile(page, file)).toHaveCount(0);
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
   * How a context file's lines are laid out: `columns` of code side by side,
   * the width they take together and the inner width of the file's element.
   * A context file is one column as wide as the file in either layout.
   */
  async function contextFileLayout(page, file) {
    return inPage(page, (D, f) => D.contextLayout(f), file);
  }

  /** The text of a line of a context file, as drawn. */
  async function contextLineText(page, file, line) {
    return contextLine(page, file, line).locator('.d2h-code-line-ctn').textContent();
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

  return {
    overrides: {
      expectContextFile,
      expectNoContextFile,
      contextFileState,
      contextLine,
      contextFileLayout,
      contextLineText,
      expandContextGap,
      expandContextGapFully,
      openContextLineCommentForm,
      contextLineChatButton,
    },
    expectations: {},
  };
}

module.exports = { extendInPage, createFileDiffAdapter };
