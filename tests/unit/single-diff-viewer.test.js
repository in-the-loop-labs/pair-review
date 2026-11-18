// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The diff pane has ONE renderer: the virtualized viewer behind PierreBridge
 * (plans/codeview-virtualized-diff.md).
 *
 * The migration to it deleted a renderer per file, an engine switch between
 * the two, and the application's own table renderer of context files with
 * everything only they used. A second path coming back is how the previous
 * attempt at this migration ended up with nineteen double-pathed branches
 * and no test on one side of each. These tests fail when a name of what was
 * deleted is back in the tree: comments included, because a comment that
 * names a function that is gone sends its reader looking for it.
 *
 * What is NOT listed here because it has a test of its own: the viewer's
 * list has one writer and nothing calls the vendor's `addItem`/`removeItem`
 * (pierre-bridge.test.js, "the list has one writer"); nothing writes markup
 * into `#diff-container` (diff-status.test.js); nothing asks the document
 * for a file's comment zone (file-comments-zone-registry.test.js).
 */

import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const THIS_FILE = path.resolve(__filename);

/** Every file under `dir` (relative to the repository) with one of the extensions, minus `skip` prefixes. */
function filesUnder(dir, extensions, skip = []) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(REPO_ROOT, full);
      if (skip.some((prefix) => relative.startsWith(prefix))) continue;
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension)) && full !== THIS_FILE) out.push(full);
    }
  };
  const start = path.join(REPO_ROOT, dir);
  if (fs.existsSync(start)) walk(start);
  return out;
}

/** `file:line: text` of every line of `files` that matches `pattern`. */
function hits(files, pattern) {
  const found = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
      if (pattern.test(text)) found.push(`${path.relative(REPO_ROOT, file)}:${index + 1}: ${text.trim().slice(0, 120)}`);
    });
  }
  return found;
}

// What ships: everything under public/ but the vendor bundle.
const SHIPPED = filesUnder('public', ['.js', '.html', '.css'], [path.join('public', 'js', 'vendor')]);
// What drives the application in tests, and the build scripts.
const TEST_AND_BUILD = [
  ...filesUnder(path.join('tests', 'e2e'), ['.js']),
  ...filesUnder(path.join('tests', 'parity'), ['.mjs', '.js']),
  ...filesUnder(path.join('tests', 'contract'), ['.js', '.html']),
  ...filesUnder(path.join('tests', 'unit'), ['.js']),
  ...filesUnder(path.join('tests', 'utils'), ['.js']),
  ...filesUnder('scripts', ['.js', '.mjs']),
];

describe('the engine switch is gone', () => {
  // The switch (a window global the E2E fixture set from an environment
  // variable, read into a field of PRManager) and the names of its two sides.
  const SWITCH_NAMES = /__PAIR_REVIEW_DIFF_ENGINE|_diffEngine\b|\bPR_ENGINE\b|codeview-engine|PierreCodeViewBridge|pierre-codeview-bridge|_usesPierre/;

  it('nothing that ships names it', () => {
    expect(SHIPPED.length).toBeGreaterThan(40);
    expect(hits(SHIPPED, SWITCH_NAMES)).toEqual([]);
  });

  it('no test, test helper or script names it', () => {
    expect(TEST_AND_BUILD.length).toBeGreaterThan(300);
    expect(hits(TEST_AND_BUILD, SWITCH_NAMES)).toEqual([]);
  });

  it('PRManager builds one bridge, the one of pierre-bridge.js, and both pages load that file once', () => {
    const pr = fs.readFileSync(path.join(REPO_ROOT, 'public', 'js', 'pr.js'), 'utf8');
    expect(pr.match(/new Bridge\(/g)).toHaveLength(1);
    expect(pr).toContain('const Bridge = window.PierreBridge;');
    for (const page of ['pr.html', 'local.html']) {
      const html = fs.readFileSync(path.join(REPO_ROOT, 'public', page), 'utf8');
      expect(html.match(/<script src="\/js\/modules\/pierre-bridge\.js"><\/script>/g), page).toHaveLength(1);
    }
  });
});

describe('the per-file renderer is gone', () => {
  // `FileDiff` as a word: the vendor's component of that name. Its metadata
  // type (FileDiffMetadata) and the viewer's own class (VirtualizedFileDiff,
  // which the development build names in its reports) are other words.
  const NAMES = [
    'FileDiff', 'ensureFileBodyRendered', '_lazyFileBodies', '_renderFileBodyNow', '_renderPierreFileBodyNow',
    'renderFileDiff', '_createFileBodyObserver', '_measureFileHeaderHeight', '_createPierreRenderBudget',
    'PIERRE_HIGHLIGHT_TOTAL_CHARS', 'PIERRE_HIGHLIGHT_TOTAL_LINES', '_fallbackToMainThreadRendering',
    '_rebuildFileInstance', '_renderWithFileDiff', 'pierre-diff-body', 'pierre-binary-file',
  ];
  const pattern = new RegExp(`(?<![\\w$-])(${NAMES.join('|')})(?![\\w$-])`);

  it('nothing that ships names it', () => {
    expect(hits(SHIPPED, pattern)).toEqual([]);
  });

  it('the E2E helpers, the parity scripts and the build scripts do not name it', () => {
    const files = [
      ...filesUnder(path.join('tests', 'e2e'), ['.js']),
      ...filesUnder(path.join('tests', 'parity'), ['.mjs', '.js']),
      ...filesUnder('scripts', ['.js', '.mjs']),
    ];
    expect(hits(files, pattern)).toEqual([]);
  });

  it('the two modules it alone used are not in the tree and not loaded by a page', () => {
    for (const name of ['line-tracker.js', 'gap-coordinates.js']) {
      expect(fs.existsSync(path.join(REPO_ROOT, 'public', 'js', 'modules', name)), name).toBe(false);
    }
    for (const page of ['pr.html', 'local.html']) {
      const html = fs.readFileSync(path.join(REPO_ROOT, 'public', page), 'utf8');
      expect(html, page).not.toMatch(/line-tracker|gap-coordinates/);
    }
  });
});

describe('the table renderer of context files is gone', () => {
  // Functions, modules, DOM and CSS of the application's own renderer of
  // diff lines as table rows, and highlight.js, which only it used.
  const NAMES = [
    'renderDiffLine', 'parseBlockLines', 'expandGapContext', 'expandGapRange', 'expandForSuggestion',
    'validatePendingEofGaps', 'createGapRowElement', 'EOF_SENTINEL', 'LineTracker', 'lineTracker', 'GapCoordinates',
    'hljs', 'findContextFileWrapper', 'renderContextFile', '_mountStopLegacy', '_insertAtOrderedPosition',
    '_buildContextChunkTbody', '_findLineRows', 'renderCodeViewFooter',
  ];
  const words = new RegExp(`(?<![\\w$-])(${NAMES.join('|')})(?![\\w$-])`);
  // Matched as written, wherever they stand in a word or a selector.
  const fragments = /renderPatch\(|highlight\.js|d2h-diff-table|d2h-code-line|context-chunk|context-expand-row|line-num2|tr\[data-line-number/;

  it('nothing that ships names a function, module or class of it', () => {
    expect(hits(SHIPPED, words)).toEqual([]);
    expect(hits(SHIPPED, fragments)).toEqual([]);
  });

  it('the diff pane loads nothing from cdnjs (highlight.js was its only use)', () => {
    for (const page of ['pr.html', 'local.html']) {
      const html = fs.readFileSync(path.join(REPO_ROOT, 'public', page), 'utf8');
      expect(html, page).not.toMatch(/cdnjs/);
    }
  });
});

describe('nothing was left half done', () => {
  it('no focused test, debugger statement or unfinished marker in what the migration touched', () => {
    const files = [
      ...filesUnder(path.join('public', 'js', 'modules'), ['.js']).filter((file) => /pierre-|diff-renderer|hunk-parser|comment-manager|suggestion-manager|external-comment-manager|tour-renderer|hunk-summary-renderer/.test(file)),
      path.join(REPO_ROOT, 'public', 'js', 'pr.js'),
      path.join(REPO_ROOT, 'public', 'js', 'local.js'),
      ...filesUnder(path.join('tests', 'e2e'), ['.js']),
      ...filesUnder(path.join('tests', 'contract'), ['.js']),
      ...filesUnder(path.join('tests', 'parity'), ['.mjs']),
    ];
    expect(hits(files, /\b(test|it|describe)\.only\(|^\s*debugger;|\bTODO\b|\bFIXME\b/)).toEqual([]);
  });
});
