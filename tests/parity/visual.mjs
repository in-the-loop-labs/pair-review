// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Visual parity of the diff pane between a reference and this tree (layer L4
 * of plans/codeview-virtualized-diff.md, next to the golden dump). The
 * reference is the application as it was before the migration to the
 * virtualized viewer: a capture this script made of it, saved in a directory,
 * or a second checkout of the repository that still has it (a `git worktree`
 * of that commit).
 *
 * The golden dump compares what a file's rows SAY. This script compares how
 * the pane LOOKS: for every changed file its geometry as numbers (header box
 * and the boxes of what is in it, the distance from the header to the first
 * row, the file's frame, the space to the next file, gutter width, row height,
 * fonts), and the pane as pixels at fixed positions (top of the pane, a file
 * header pinned over a hunk, a collapsed file, the end of the pane, a context
 * file), and with something drawn on the diff: comment and suggestion cards
 * under lines and in a file's comment zone, a hunk summary, open comment
 * forms, a line selection, minimized comments, review threads from the pull
 * request (PR mode), a comment in a context file's zone, and the message of
 * a file whose diff is held back for its size (the box of every card as
 * numbers, and the pane as pixels).
 *
 * A second page per configuration lets the file contents arrive, and compares
 * what a reader sees from then on: every file once its contents are loaded
 * (numbers, and the pane as pixels), a hidden gap expanded by one step and
 * then in full, a line revealed by a navigation, a flashed line (the
 * animation stopped at a fixed time), and where navigation lands: a sidebar
 * click, a chat link to a line, a tour's first stop, a click on a finding in
 * the review panel, and that click on a finding in a collapsed file (each as
 * a number, the target's distance from what is pinned above the diff, and as
 * pixels).
 *
 * Both sides are captured the same way, with the file-contents requests held
 * back on the first page, so every changed file shows the rows of its patch
 * on both and the two screenshots of a position can be compared pixel by
 * pixel. A context file is drawn differently by decision D2; its screenshots
 * are saved and its pixels are not compared (its header, frame and place are
 * compared as numbers).
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=... node tests/parity/visual.mjs --out <dir>
 *     --reference <dir> | --reference-checkout <path>
 *     [--corpus default,edge,lazy] [--mode pr,local] [--style unified,split] [--theme light,dark]
 *
 *   --reference <dir>            a capture made earlier: the directory that
 *                                holds its <config>.json and .png files (what
 *                                reference.mjs saves as <out>/visual/reference)
 *   --reference-checkout <path>  a second checkout; its own copy of this script
 *                                captures it into <out>/reference first (one
 *                                browser at a time: the captures run one after
 *                                the other)
 *
 * Corpora: `default` and `edge` are the E2E fixtures' (tests/e2e/fixtures/diffs.js);
 * `lazy` is built here, a file whose diff is held back for its size.
 *
 * Writes <out>/candidate/<config>.json and <config>.<position>.png (this
 * tree), <out>/compare/<config>.<position>.png (the reference, this tree, and
 * the pixels that differ, side by side: red outside the anti-aliasing
 * tolerance, amber within it), <out>/REPORT.json and <out>/REPORT.txt.
 * Exit code 1 when a number differs and is not in ACCEPTED below, or a
 * compared screenshot has a pixel outside the tolerance (see diffImages).
 *
 * With VISUAL_COMPARE_ONLY=1 the captures already there are compared again
 * and nothing is captured.
 *
 * `--capture <name>` (what the two options above run) captures the tree the
 * script is in into <out>/<name> and compares nothing.
 *
 * Do not run it while the E2E suite is running (a second browser).
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
process.env.PAIR_REVIEW_NO_OPEN = '1';

const MODES = {
  pr: { path: '/pr/test-owner/test-repo/1', reviewId: 1 },
  local: { path: '/local/2', reviewId: 2 },
};
const VIEWPORT = { width: 1440, height: 900 };

/**
 * The context files of the `context` positions: one that sorts before every
 * changed file (30 generic lines from the test server) and one with two
 * ranges (240 lines, registered by the test server).
 */
const CONTEXT_FILES = [
  { file: 'aa/context-first.js', ranges: [[8, 22]] },
  { file: 'corpus-evict/context-long.js', ranges: [[20, 30], [150, 160]] },
];

/** The one stop of the tour of the `tour` positions, per corpus: a line the patch adds. */
const TOUR_STOP = {
  default: { file_path: 'src/utils.js', side: 'RIGHT', line_start: 4, line_end: 4 },
  edge: { file_path: 'corpus-edge/added.js', side: 'RIGHT', line_start: 5, line_end: 5 },
};

/**
 * Differences that are decided, each with the decision that covers it. A
 * difference that matches no entry fails the run.
 *   where: 'number' (a geometry path; test({ kind, path, a, b })) or
 *          'pixels' (a position of a configuration; test({ config, position }))
 */
const ACCEPTED = [
  {
    where: 'number',
    test: ({ kind, path: key }) => kind === 'pane' && /^scroller\./.test(key),
    why: 'plan 3.2: the viewer\'s root is the scroll container, so the toolbar and the tour bar are above it and not pinned inside it; a scrollbar, where the system draws one, starts under them',
  },
  {
    where: 'number',
    test: ({ kind, path: key }) => kind === 'context' && /^(firstRowOffset|firstRow\.|lastContentToBottom|file\.h$)/.test(key),
    why: 'D2: a context file\'s lines are drawn by the viewer (one number column, the viewer\'s separators); its header and its place are compared',
  },
  {
    where: 'pixels',
    test: ({ config, position }) => config.corpusName === 'edge' && config.style === 'split' && position === 'end',
    why: 'the second and third lines of wrapped rows are drawn one pixel higher or lower (11 text lines of 8 px, 1,143 pixels outside the tolerance; no line, box or colour differs). The files there are at fractional offsets (heights of wrapped rows are not whole pixels), and where a glyph row lands on the pixel grid depends on the layer it is painted in: the page\'s scrolling layer on the default engine, the viewer\'s pinned container on codeview. The layout is the same: every file\'s box is equal in the numbers, and so is where the last file ends (the number "lastFileBottomToViewBottom"). Ledger H126',
  },
  {
    where: 'number',
    test: ({ kind, path: key }) => kind === 'contextCards' && key === 'fileHeight',
    why: 'D2: a context file\'s lines are drawn by the viewer, so the file is another height; its comment zone and the card in it are compared',
  },
  {
    where: 'number',
    test: ({ kind, path: key, a, b }) => (kind === 'diff' || kind === 'upgraded') && /^frame(\.|$)/.test(key) && !!a.frame && a.frame.h === 1 && !b.frame,
    why: 'a diff without a line: the 1 px line under the header is the empty code block\'s border on the default engine (a frame 1 px high) and is drawn in the file\'s comment zone on codeview, where a file without lines has no frame (the viewer counts no bottom padding for an item without lines); the pixels are compared',
  },
  {
    where: 'number',
    test: ({ kind, path: key, a, b }) => kind === 'landing' && /BelowPinned$/.test(key)
      && typeof a[key] === 'number' && typeof b[key] === 'number' && Math.abs(a[key] - b[key]) <= 1,
    why: 'a landing within one pixel, the rule the golden comparison has for landings. A navigation\'s scroll ends on a whole pixel of the scroll offset, the target itself is at a fraction of one (wrapped rows above it have heights that are not whole pixels), and the two engines scroll two different containers, whose contents start at different fractions: the target is the same fraction of a pixel off on each, in different directions (measured: 0.56 to 0.68 px, edge corpus, a click on a finding). Landings that are not bounded this way are equal to the hundredth',
  },
  {
    where: 'pixels',
    test: ({ config, position, visible }) => config.corpusName === 'edge' && config.style === 'unified' && config.theme === 'light'
      && /^landing-finding/.test(position) && visible <= 4,
    why: 'the landing above, 0.68 px apart: the first row of pixels under the pinned file header shows the next slice of a text line on one engine (2 pixels of one glyph outside the tolerance, at the header\'s lower edge); no line, box or colour differs',
  },
];

/**
 * The corpus named `lazy`: one file whose diff is held back for its size (a
 * header and "Large diff ... Load diff" in place of its lines) above a small
 * one. Built here: a builder corpus has no file that large.
 */
function lazyCorpus(corpora) {
  const big = [];
  for (let i = 0; i < 20100; i++) big.push(`// big line ${i}`);
  const diff = [
    'diff --git a/src/main.js b/src/main.js', '--- a/src/main.js', '+++ b/src/main.js', '@@ -0,0 +1,20100 @@',
    ...big.map((line) => `+${line}`),
    'diff --git a/src/utils.js b/src/utils.js', '--- a/src/utils.js', '+++ b/src/utils.js', '@@ -1,2 +1,3 @@',
    ' line a', '+added line', ' line b', '',
  ].join('\n');
  return corpora.customCorpus({
    name: 'lazy',
    diff,
    files: {
      'src/main.js': { old: '', new: `${big.join('\n')}\n` },
      'src/utils.js': { old: 'line a\nline b\n', new: 'line a\nadded line\nline b\n' },
    },
  });
}

/** A corpus by the name the command line gives it. */
function corpusNamed(corpora, name) {
  return name === 'lazy' ? lazyCorpus(corpora) : corpora.allCorpora()[name];
}

function parseArgs(argv) {
  const args = {
    corpus: ['default', 'edge', 'lazy'], mode: ['pr', 'local'], style: ['unified', 'split'], theme: ['light', 'dark'],
    out: null, capture: null, reference: null, 'reference-checkout': null,
  };
  const single = new Set(['out', 'capture', 'reference', 'reference-checkout']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in args) || value === undefined) throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    args[key] = single.has(key) ? value : value.split(',');
    i++;
  }
  if (!args.out) throw new Error('--out <dir> is required');
  if (!args.capture && !args.reference && !args['reference-checkout']) {
    throw new Error('--reference <dir> or --reference-checkout <path> is required');
  }
  if (args.reference && args['reference-checkout']) throw new Error('give --reference or --reference-checkout, not both');
  return args;
}

/** The environment a capture of another checkout runs in: what a browser and the test server need, and nothing this shell happens to export. */
function captureEnvironment() {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function configsOf(args) {
  const configs = [];
  for (const corpusName of args.corpus) {
    for (const mode of args.mode) {
      for (const style of args.style) {
        for (const theme of args.theme) configs.push({ corpusName, mode, style, theme, name: `${corpusName}.${mode}.${style}.${theme}` });
      }
    }
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Capture (one tree per process: the tree this script is in)
// ---------------------------------------------------------------------------

/* eslint-disable no-undef */
/** Runs in the page. The geometry of one file of the pane, as numbers. */
function measureFile(D, file) {
  const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
  const wrapper = D.wrapper(file) || D.contextWrapper(file);
  if (!wrapper) return null;
  const pane = document.getElementById('diff-container').getBoundingClientRect();
  const box = wrapper.getBoundingClientRect();
  const rel = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: round(r.left - box.left), y: round(r.top - box.top), w: round(r.width), h: round(r.height) };
  };
  const css = (el, ...props) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, style.getPropertyValue(p)]));
  };

  const borderOf = (el, side) => {
    const s = getComputedStyle(el);
    const width = parseFloat(s.getPropertyValue(`border-${side}-width`));
    // A transparent border draws nothing.
    if (/rgba\(\d+, \d+, \d+, 0\)/.test(s.getPropertyValue(`border-${side}-color`))) return 'none';
    return width > 0 ? `${width}px ${s.getPropertyValue(`border-${side}-style`)} ${s.getPropertyValue(`border-${side}-color`)}` : 'none';
  };

  const header = wrapper.querySelector('.d2h-file-header');
  const part = (selector) => rel(header && header.querySelector(selector));
  const host = D.hostOf(wrapper);
  const shadow = (host && host.shadowRoot) || null;
  const collapsed = wrapper.classList.contains('collapsed');

  // What is drawn under the header, top to bottom: the viewer's rows and
  // separators.
  let content = [];
  if (!collapsed && shadow) {
    content = [...shadow.querySelectorAll('[data-line], [data-separator]')]
      .filter((el) => el.getBoundingClientRect().height > 0);
  }
  const tops = content.map((el) => el.getBoundingClientRect().top);
  const bottoms = content.map((el) => el.getBoundingClientRect().bottom);
  const headerBox = header ? header.getBoundingClientRect() : null;

  // The first line of code and its number cell.
  const firstLine = shadow ? shadow.querySelector('[data-content] [data-line], [data-line]') : null;
  const firstNumber = shadow ? shadow.querySelector('[data-column-number]') : null;

  // The frame: the element that draws a border around the file's lines.
  const frameCandidates = [
    shadow && shadow.querySelector('pre[data-diff]'),
    wrapper,
  ].filter(Boolean);
  const hasBorder = (el) => ['left', 'right', 'bottom'].some((side) => borderOf(el, side) !== 'none');
  // A frame without any height draws nothing (a file without a code block).
  const frameEl = collapsed ? null : (frameCandidates.find((el) => hasBorder(el) && el.getBoundingClientRect().height > 0) || null);
  const all = D.wrappers();
  const next = all[all.indexOf(wrapper) + 1] || null;

  return {
    kind: wrapper.classList.contains('context-file') ? 'context' : 'diff',
    collapsed,
    file: {
      x: round(box.left - pane.left),
      rightInset: round(pane.right - box.right),
      w: round(box.width),
      h: round(box.height),
      borderLeft: borderOf(wrapper, 'left'),
    },
    header: header ? {
      ...rel(header),
      ...css(header, 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-bottom-width', 'border-bottom-color',
        'border-top-left-radius', 'border-top-right-radius', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'gap'),
    } : null,
    parts: header ? {
      toggle: part('.file-collapse-toggle'),
      name: part('.d2h-file-name'),
      badge: part('.context-badge, .generated-badge, .file-status-badge'),
      stats: part('.file-stats-summary'),
      viewed: part('.file-viewed-label'),
      commentButton: part('.file-header-comment-btn'),
      dismiss: part('.context-file-dismiss'),
    } : null,
    nameFont: header && header.querySelector('.d2h-file-name')
      ? css(header.querySelector('.d2h-file-name'), 'font-family', 'font-size', 'font-weight', 'line-height', 'color') : null,
    firstRowOffset: content.length && headerBox ? round(Math.min(...tops) - headerBox.bottom) : null,
    lastContentToBottom: content.length ? round(box.bottom - Math.max(...bottoms)) : null,
    firstRow: firstLine && !collapsed ? {
      h: round(firstLine.getBoundingClientRect().height),
      x: round(firstLine.getBoundingClientRect().left - box.left),
      numberCell: rel(firstNumber),
      ...css(firstLine, 'font-family', 'font-size', 'line-height'),
    } : null,
    frame: frameEl ? {
      ...rel(frameEl),
      left: borderOf(frameEl, 'left'),
      right: borderOf(frameEl, 'right'),
      bottom: borderOf(frameEl, 'bottom'),
      ...css(frameEl, 'border-bottom-left-radius', 'border-bottom-right-radius'),
    } : null,
    gapToNext: next ? round(next.getBoundingClientRect().top - box.bottom) : null,
    // A file whose diff is held back for its size: the message and its button.
    notice: rel(wrapper.querySelector('.large-diff-placeholder')),
    loadButton: rel(wrapper.querySelector('.large-diff-load-btn')),
  };
}

/**
 * Runs in the page. The boxes of what is drawn on one file besides its lines,
 * relative to the file: its comment zone and what is in it, the cards and
 * forms under its lines, a hunk summary, the indicators of minimized
 * comments. In document order per kind.
 */
function measureCards(D, file) {
  const round = (n) => Math.round(n * 100) / 100;
  const wrapper = D.wrapper(file) || D.contextWrapper(file);
  if (!wrapper) return null;
  const box = wrapper.getBoundingClientRect();
  const kinds = {
    zoneCard: '.file-comments-zone .file-comment-card',
    zoneSuggestion: '.file-comments-zone .ai-suggestion',
    zoneForm: '.file-comments-zone .file-comment-form',
    comment: '[data-annotation-slot] > .user-comment-row',
    suggestion: '[data-annotation-slot] > .ai-suggestion',
    lineForm: '[data-annotation-slot] > .user-comment-form',
    external: '[data-annotation-slot] > .external-comment-row',
    summary: '.hunk-summary-row',
    indicator: '.comment-indicator',
  };
  const out = {};
  for (const [kind, selector] of Object.entries(kinds)) {
    out[kind] = [...wrapper.querySelectorAll(selector)]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: round(r.left - box.left), y: round(r.top - box.top), w: round(r.width), h: round(r.height), rightInset: round(box.right - r.right) }));
  }
  // The zone's line under its content is the zone's own border on one
  // engine and its content box's on the other: where the line ends is what
  // a reader sees.
  const zoneEl = wrapper.querySelector('.file-comments-zone');
  const content = zoneEl && zoneEl.querySelector('.file-comments-container');
  out.zone = [];
  if (content && content.getBoundingClientRect().height > 0) {
    const r = content.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(zoneEl).borderBottomWidth) || 0;
    out.zone.push({ x: round(r.left - box.left), y: round(r.top - box.top), w: round(r.width), bottom: round(r.bottom + line - box.top), rightInset: round(box.right - r.right) });
  }
  out.fileHeight = round(box.height);
  return out;
}

/** Runs in the page. The pane's own box: borders, radius, padding as a reader sees them at the top of the pane. */
function measurePane(D) {
  const round = (n) => Math.round(n * 100) / 100;
  const view = document.querySelector('.diff-view').getBoundingClientRect();
  const toolbar = document.querySelector('.diff-toolbar');
  const tourBar = document.querySelector('.tour-bar');
  const first = D.wrappers()[0];
  const out = {
    view: { w: round(view.width), h: round(view.height) },
    toolbar: toolbar ? { y: round(toolbar.getBoundingClientRect().top - view.top), h: round(toolbar.getBoundingClientRect().height) } : null,
    tourBar: tourBar ? { y: round(tourBar.getBoundingClientRect().top - view.top), h: round(tourBar.getBoundingClientRect().height) } : null,
    // The element that scrolls, and so where a scrollbar is drawn on a system that draws one.
    scroller: { y: round(D.scroller().getBoundingClientRect().top - view.top), h: round(D.scroller().getBoundingClientRect().height) },
    firstFile: first ? {
      x: round(first.getBoundingClientRect().left - view.left),
      y: round(first.getBoundingClientRect().top - view.top),
      rightInset: round(view.right - first.getBoundingClientRect().right),
    } : null,
  };
  return out;
}
/* eslint-enable no-undef */

async function capture(args, name) {
  const { startTestServer } = require('../e2e/test-server.js');
  const corpora = require('../e2e/fixtures/diffs.js');
  const dom = require('../e2e/diff-dom.js');
  const helpers = require('../e2e/helpers.js');
  const outDir = path.join(args.out, name);
  fs.mkdirSync(outDir, { recursive: true });

  const { server, db, port } = await startTestServer(await freePort());
  const baseURL = `http://localhost:${port}`;
  const browser = await chromium.launch({ headless: true });

  /** Put `file`'s top edge `offset` px below whatever is pinned above the diff. */
  const alignFile = async (page, file, offset) => {
    if (dom.ensureMounted) await dom.ensureMounted(page, file);
    for (let pass = 0; pass < 3; pass++) {
      await dom.inPage(page, (D, { f, off }) => {
        const w = D.wrapper(f) || D.contextWrapper(f);
        if (!w) return;
        const s = D.scroller();
        D.setScrollTop(s.scrollTop + w.getBoundingClientRect().top - (D.pinnedBottom() + off));
      }, { f: file, off: offset });
      await settle(page);
    }
  };
  /** Two animation frames, then until the pane's files have not moved for three more. */
  const settle = async (page) => {
    let previous = null;
    let same = 0;
    const deadline = Date.now() + 10000;
    while (same < 3 && Date.now() < deadline) {
      const current = await dom.inPage(page, (D) => JSON.stringify(D.wrappers().map((w) => {
        const r = w.getBoundingClientRect();
        return [w.dataset.fileName, Math.round(r.top * 100), Math.round(r.height * 100)];
      })));
      same = current === previous ? same + 1 : 0;
      previous = current;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  };
  /** Scroll to an edge of the pane until the pane stays there (a navigation in flight may move it again). */
  const restAt = async (page, edge) => {
    const deadline = Date.now() + 15000;
    let still = 0;
    let last = null;
    while (still < 20 && Date.now() < deadline) {
      await dom.scrollDiffToEdge(page, edge);
      const { top } = await dom.scrollState(page);
      still = top === last ? still + 1 : 0;
      last = top;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
  };
  const shoot = async (page, name, position, { animations = 'disabled' } = {}) => {
    // The pointer is parked outside the pane: no hover state in any shot.
    await page.mouse.move(2, 2);
    await settle(page);
    await page.locator('.diff-view').screenshot({ path: path.join(outDir, `${name}.${position}.png`), animations });
  };

  /**
   * The second page of a configuration: the file contents arrive, so every
   * changed file is drawn from its two contents, hidden lines can be
   * expanded and revealed, and navigation lands on what it will stay on.
   */
  const upgradedStage = async ({ context, config, corpus, order, tourStop, annotated, result, shoot, settle, alignFile }) => {
    const reviewId = MODES[config.mode].reviewId;
    const page = await context.newPage();
    const round = (value) => (value == null ? null : Math.round(value * 100) / 100);
    const frames = (count) => page.evaluate((n) => new Promise((resolve) => {
      const tick = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
      tick(n);
    }), count);
    /** Until the pane has been at one scroll position for 30 frames (navigation scrolls smoothly, then corrects itself). */
    const scrollAtRest = async () => {
      const deadline = Date.now() + 15000;
      let still = 0;
      let last = null;
      while (still < 30 && Date.now() < deadline) {
        const { top } = await dom.scrollState(page);
        still = top === last ? still + 1 : 0;
        last = top;
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      }
    };
    /** How far below what is pinned above the diff an element's top edge is. */
    const belowPinned = async (locator) => {
      const box = await locator.first().boundingBox().catch(() => null);
      const pinned = await dom.inPage(page, (D) => D.pinnedBottom());
      return box ? round(box.y - pinned) : null;
    };
    const rowTopBelowPinned = (file, line) => dom.inPage(page, (D, { f, l }) => {
      const box = D.rowBox ? D.rowBox(f, l, 'additions') : null;
      return box ? Math.round((box.top - D.pinnedBottom()) * 100) / 100 : null;
    }, { f: file, l: line }).catch(() => null);
    const open = async () => {
      await corpora.routeDiff(page, corpus);
      if (tourStop) {
        await helpers.mockAppConfig(page, { tours: { enabled: true }, summaries: { enabled: true } });
        await helpers.mockTour(page, [{ ...tourStop, title: 'A stop', description: 'A stop of the tour.' }]);
        await helpers.mockHunkSummaries(page, []);
      }
      if (config.mode === 'pr') await helpers.mockExternalComments(page, []);
      await page.goto(`${baseURL}${MODES[config.mode].path}`);
      await page.waitForSelector('#diff-container .d2h-file-wrapper[data-file-name]', { timeout: 15000 });
      for (const file of order) {
        await alignFile(page, file, 40);
        await dom.ensureContentUpgrade(page, file).catch(() => false);
        await dom.waitForFileSettled(page, file).catch(() => {});
      }
      await dom.waitForDiffSettled(page).catch(() => {});
      await dom.scrollDiffToEdge(page, 'top');
      await settle(page);
    };
    const upgradedShot = async (position, options) => {
      await shoot(page, config.name, position, options);
      result.positions.push(position);
    };

    await open();
    result.upgraded = { files: {}, landings: {}, gap: {} };

    // Every changed file with its contents loaded: numbers, and the two ends of the pane.
    for (const file of order) {
      await alignFile(page, file, 40);
      result.upgraded.files[file] = await dom.inPage(page, measureFile, file);
    }
    await dom.scrollDiffToEdge(page, 'top');
    await upgradedShot('upgraded-top');
    await dom.scrollDiffToEdge(page, 'bottom');
    await upgradedShot('upgraded-end');

    // A hidden gap: expanded by one step, then in full. The first file that
    // has an expand control once its contents are loaded.
    let gapFile = null;
    for (const file of order) {
      await alignFile(page, file, 40);
      if (await dom.expandControls(dom.fileWrapper(page, file), 'directional').count()) { gapFile = file; break; }
    }
    const rowsOf = async (file) => (await dom.dumpFile(page, file)).columns.reduce((n, column) => n + column.rows.length, 0);
    const separatorsOf = async (file) => (await dom.dumpFile(page, file)).separators;
    if (gapFile) {
      const before = await rowsOf(gapFile);
      await dom.clickExpandControl(page, gapFile, 0);
      const deadline = Date.now() + 10000;
      while ((await rowsOf(gapFile)) === before && Date.now() < deadline) await frames(2);
      await dom.waitForDiffSettled(page).catch(() => {});
      await alignFile(page, gapFile, 40);
      result.upgraded.gap.partial = { file: gapFile, rows: await rowsOf(gapFile), separators: await separatorsOf(gapFile), geometry: await dom.inPage(page, measureFile, gapFile) };
      await upgradedShot('gap-partial');
      // Until the file has no separator with a control left (at most a few steps).
      for (let step = 0; step < 12 && await dom.expandControls(dom.fileWrapper(page, gapFile), 'directional').count(); step++) {
        const rows = await rowsOf(gapFile);
        await dom.clickExpandControl(page, gapFile, 0);
        const until = Date.now() + 10000;
        while ((await rowsOf(gapFile)) === rows && Date.now() < until) await frames(2);
      }
      await dom.waitForDiffSettled(page).catch(() => {});
      await alignFile(page, gapFile, 40);
      result.upgraded.gap.expanded = { file: gapFile, rows: await rowsOf(gapFile), separators: await separatorsOf(gapFile), geometry: await dom.inPage(page, measureFile, gapFile) };
      await upgradedShot('gap-expanded');
    }

    // The landings start from a page as it loads: nothing expanded.
    await page.reload();
    await open();

    // A line revealed by a navigation (what a click on a finding or a link
    // does first): the middle of the first gap of the gap file.
    if (gapFile) {
      // A line the file does not show: the middle of the gap between its
      // first two hunks, or a line well after (or before) its only hunk.
      const hunks = corpus.files[gapFile] ? corpora.changedLines(corpus, gapFile).hunks : [];
      const candidates = hunks.length > 1
        ? [Math.floor((hunks[0].newStart + hunks[0].newCount + hunks[1].newStart) / 2)]
        : hunks.length === 1 ? [hunks[0].newStart + hunks[0].newCount + 12, hunks[0].newStart - 12].filter((n) => n > 0) : [];
      let line = null;
      for (const candidate of candidates) {
        if (!(await dom.isLineVisible(page, gapFile, candidate))) { line = candidate; break; }
      }
      if (line) {
        await page.evaluate(({ f, l }) => window.prManager.ensureLinesVisible([{ file: f, line_start: l, line_end: l, side: 'RIGHT' }]), { f: gapFile, l: line });
        await dom.waitForDiffSettled(page).catch(() => {});
        await alignFile(page, gapFile, 40);
        result.upgraded.gap.revealed = { file: gapFile, line, rows: await rowsOf(gapFile), separators: await separatorsOf(gapFile), geometry: await dom.inPage(page, measureFile, gapFile) };
        await upgradedShot('revealed');
        await page.reload();
        await open();
      }
    }

    const target = order[order.length - 1];
    const targetLine = corpus.files[target] && !corpus.files[target].binary ? corpora.changedLines(corpus, target).additions[0] : null;

    // Landing: a click on a file in the sidebar.
    {
      const item = page.locator(`.file-item[data-path=${JSON.stringify(target)}]`).first();
      if (await item.count()) {
        await item.click();
        await scrollAtRest();
        const landed = await dom.headerLanding(page, target);
        result.upgraded.landings.sidebar = { file: target, headerBelowPinned: landed ? round(landed.belowPinned) : null };
        await upgradedShot('landing-sidebar');
      }
    }

    // Landing: a chat link to a line, and the flash on that line. The flash
    // fades for 3.5 s: it is stopped half a second in on both engines.
    if (targetLine) {
      await dom.scrollDiffToEdge(page, 'top');
      await settle(page);
      await helpers.enableChat(page);
      await page.waitForFunction(() => !!window.chatPanel);
      await page.evaluate(({ f, l }) => {
        const link = document.createElement('a');
        link.dataset.file = f;
        link.dataset.lineStart = String(l);
        return window.chatPanel._handleFileLinkClick(link);
      }, { f: target, l: targetLine });
      const flashed = async () => (await dom.flashedLines(page, target)).includes(targetLine);
      const until = Date.now() + 10000;
      while (!(await flashed()) && Date.now() < until) await frames(1);
      const paused = await page.evaluate(() => {
        // The flashed rows are inside the viewer's shadow trees.
        const roots = [document, ...[...document.querySelectorAll('#diff-container diffs-container')].map((host) => host.shadowRoot).filter(Boolean)];
        const flashes = roots.flatMap((root) => root.getAnimations()).filter((animation) => animation.animationName === 'pierre-line-highlight-flash');
        for (const animation of flashes) { animation.pause(); animation.currentTime = 500; }
        window.__flashes = flashes;
        return new Set(flashes).size;
      });
      await scrollAtRest();
      result.upgraded.landings.chatLink = { file: target, line: targetLine, flashedRows: paused, rowBelowPinned: await rowTopBelowPinned(target, targetLine) };
      await upgradedShot('landing-chat-link', { animations: 'allow' });
      // Let the flash run out as it does for a reader: each engine takes it
      // off the line in its own way when it ends, and the next positions are
      // of the pane without it.
      await page.evaluate(() => {
        for (const animation of window.__flashes || []) { animation.currentTime = 3400; animation.play(); }
        window.__flashes = null;
      });
      const gone = Date.now() + 10000;
      while ((await dom.flashedLines(page, target)).length && Date.now() < gone) await frames(2);
    }

    // Landing: the first stop of a tour.
    if (tourStop) {
      await dom.scrollDiffToEdge(page, 'bottom');
      await settle(page);
      await page.locator('#tour-toggle-btn').click();
      await page.locator('.tour-bar .tour-bar__progress').waitFor({ state: 'visible', timeout: 10000 });
      const stop = page.locator('.tour-annotation-row').first();
      await stop.waitFor({ state: 'visible', timeout: 10000 });
      await scrollAtRest();
      result.upgraded.landings.tourStop = { file: tourStop.file_path, stopBelowPinned: await belowPinned(stop) };
      await upgradedShot('landing-tour-stop');
      await page.locator('.tour-bar .tour-bar__exit').click();
      await page.locator('.tour-bar').waitFor({ state: 'detached', timeout: 10000 });
      await scrollAtRest();
    }

    // Landings: a click on a finding in the review panel, with its file
    // open and with its file collapsed (the click opens it).
    if (targetLine) {
      const [suggestionId] = await helpers.seedSuggestions(page, reviewId, [
        { file: target, line_start: targetLine, title: 'A finding to go to', body: 'Its body.' },
      ]);
      const card = dom.inlineSuggestion(page, suggestionId);
      await alignFile(page, target, 40);
      await card.waitFor({ state: 'attached', timeout: 15000 });
      await page.evaluate(() => window.aiPanel && window.aiPanel.expand());
      const item = page.locator(`.finding-item[data-id="${suggestionId}"]`);
      await item.waitFor({ state: 'visible', timeout: 10000 });
      const finished = () => page.evaluate(() => Promise.all(document.getAnimations()
        .filter((animation) => animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => {}))));
      const clickFinding = async (name) => {
        await dom.scrollDiffToEdge(page, 'top');
        await settle(page);
        await item.click();
        const reached = await card.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
        await scrollAtRest();
        await finished();
        // The card is marked as the one just gone to for two seconds.
        await page.evaluate(() => document.querySelectorAll('.current-suggestion').forEach((el) => el.classList.remove('current-suggestion')));
        result.upgraded.landings[name] = {
          file: target, line: targetLine, reached,
          cardBelowPinned: reached ? await belowPinned(card) : null,
          collapsed: await page.evaluate((f) => window.prManager.isFileCollapsed(f), target),
        };
        await upgradedShot(`landing-${name}`);
      };
      await clickFinding('finding');
      await page.evaluate((f) => window.prManager.setFileCollapsed(f, true), target);
      await settle(page);
      await clickFinding('finding-collapsed');
      await helpers.cleanupAllComments(page, reviewId);
    }
    await page.close();
  };

  try {
    for (const config of configsOf(args)) {
      const corpus = corpusNamed(corpora, config.corpusName);
      if (!corpus) throw new Error(`Unknown corpus "${config.corpusName}"`);
      const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
      await context.addInitScript(({ style, theme }) => {
        window.localStorage.setItem('pair-review-diff-view', style);
        window.localStorage.setItem('theme', theme);
      }, { style: config.style, theme: config.theme });
      const page = await context.newPage();
      await corpora.routeDiff(page, corpus);
      const tourStop = TOUR_STOP[config.corpusName] || null;
      // The file the cards, forms and the selection are drawn on: the tour's.
      const annotated = tourStop ? tourStop.file_path : null;
      if (tourStop) {
        await helpers.mockAppConfig(page, { tours: { enabled: true }, summaries: { enabled: true } });
        await helpers.mockTour(page, [{ ...tourStop, title: 'A stop', description: 'A stop of the tour.' }]);
        // A summary on the annotated file's first hunk, in every position.
        const [firstHunk] = corpora.hunkHashes(corpus.diff).get(annotated) || [];
        await helpers.mockHunkSummaries(page, firstHunk
          ? [{ file_path: annotated, content_hash: firstHunk, summary_text: 'What this hunk does, said in one sentence.' }]
          : []);
      }
      // The review threads of the pull request: none until the position that shows them.
      const external = config.mode === 'pr' ? await helpers.mockExternalComments(page, []) : null;
      // Held for the whole run: every changed file shows the rows of its
      // patch on both engines.
      await page.route(/\/api\/reviews\/\d+\/file-contents\//, () => {});
      await page.goto(`${baseURL}${MODES[config.mode].path}`);
      await page.waitForSelector('#diff-container .d2h-file-wrapper[data-file-name]', { timeout: 15000 });
      await dom.waitForDiffSettled(page).catch(() => {});
      const order = (await dom.filesInPane(page)).filter((e) => e.kind === 'diff').map((e) => e.file);
      const result = { meta: { ...config, capture: name, viewport: `${VIEWPORT.width}x${VIEWPORT.height}` }, order, files: {}, positions: [] };

      // Position: the top of the pane.
      await dom.scrollDiffToEdge(page, 'top');
      result.pane = await dom.inPage(page, measurePane);
      await shoot(page, config.name, 'top');
      result.positions.push('top');

      // Numbers for every changed file, each with its top edge 40 px below the toolbar.
      for (const file of order) {
        await alignFile(page, file, 40);
        result.files[file] = await dom.inPage(page, measureFile, file);
      }

      // Position: a file's header pinned over one of its hunks.
      const long = corpus.target && order.includes(corpus.target) ? corpus.target : order[Math.min(1, order.length - 1)];
      await alignFile(page, long, -120);
      await shoot(page, config.name, 'pinned');
      result.positions.push('pinned');

      // Position: the end of the pane. Where the last file ends there is a
      // number too, so that a shift of less than a pixel cannot hide in the
      // tolerance of the pixel comparison.
      await dom.scrollDiffToEdge(page, 'bottom');
      await settle(page);
      result.end = await dom.inPage(page, (D) => {
        const last = D.wrappers().pop();
        const view = document.querySelector('.diff-view').getBoundingClientRect();
        return last ? { lastFileBottomToViewBottom: Math.round((view.bottom - last.getBoundingClientRect().bottom) * 1000) / 1000 } : null;
      });
      await shoot(page, config.name, 'end');
      result.positions.push('end');

      // Position: a collapsed file between two others (the header's own toggle).
      const middle = order[Math.min(1, order.length - 1)];
      await alignFile(page, middle, 40);
      const wasCollapsed = await dom.inPage(page, (D, f) => D.wrapper(f).classList.contains('collapsed'), middle);
      if (!wasCollapsed) {
        await dom.fileWrapper(page, middle).locator('.file-collapse-toggle').click();
        await dom.inPage(page, (D, f) => new Promise((resolve) => {
          const poll = () => (D.wrapper(f) && D.wrapper(f).classList.contains('collapsed') ? resolve() : requestAnimationFrame(poll));
          poll();
        }), middle);
      }
      await alignFile(page, middle, 40);
      result.collapsed = { file: middle, geometry: await dom.inPage(page, measureFile, middle) };
      await shoot(page, config.name, 'collapsed');
      result.positions.push('collapsed');
      if (!wasCollapsed) await dom.fileWrapper(page, middle).locator('.file-collapse-toggle').click();

      // Positions: what is drawn on the diff. Everything is on one file,
      // whose top edge is 40 px below the toolbar in every shot.
      if (annotated && order.includes(annotated)) {
        const reviewId = MODES[config.mode].reviewId;
        const added = corpora.changedLines(corpus, annotated).additions;
        const line = (i) => added[Math.min(i, added.length - 1)];
        const frames = (count) => page.evaluate((n) => new Promise((resolve) => {
          const tick = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
          tick(n);
        }), count);
        const annotatedShot = async (position) => {
          await alignFile(page, annotated, 40);
          // A card slides in when it is attached (slideUp, 0.3 s, a
          // transform): its box is measured where the animation has ended.
          await page.evaluate(() => Promise.all(document.getAnimations()
            .filter((animation) => animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime))
            .map((animation) => animation.finished.catch(() => {}))));
          result.cards[position] = await dom.inPage(page, measureCards, annotated);
          await shoot(page, config.name, position);
          result.positions.push(position);
        };
        result.cards = {};

        // Cards: a line comment, a comment on a range, suggestions in each
        // state, and the file's comment zone with a comment and a suggestion.
        await helpers.seedComment(page, reviewId, { file: annotated, line: line(0), body: 'A line comment.\n\nA second paragraph, with `code` in it.' });
        if (line(2) > line(1)) await helpers.seedComment(page, reviewId, { file: annotated, line: line(1), lineEnd: line(2), body: 'A comment on a range of lines.' });
        await helpers.seedComment(page, reviewId, { file: annotated, body: 'A comment on the whole file.', fileLevel: true });
        await helpers.reloadComments(page);
        await helpers.seedSuggestions(page, reviewId, [
          { file: annotated, line_start: line(1), type: 'bug', title: 'An open suggestion', body: 'Its body, with a `code` span.' },
          { file: annotated, line_start: line(2), type: 'improvement', title: 'A dismissed suggestion', body: 'Dismissed by the reader.', status: 'dismissed' },
          { file: annotated, line_start: line(3), type: 'suggestion', title: 'An adopted suggestion', body: 'Adopted by the reader.', status: 'adopted' },
          { file: annotated, line_start: line(3), type: 'praise', title: 'Praise', body: 'Nicely done.' },
          { file: annotated, type: 'design', title: 'A suggestion about the file', body: 'About the whole file.', is_file_level: true },
        ]);
        await frames(4);
        await annotatedShot('cards');

        // Minimized comments: the cards are hidden, their lines carry indicators.
        await helpers.setMinimize(page, true);
        await frames(4);
        await annotatedShot('minimized');
        await helpers.setMinimize(page, false);
        await frames(4);

        // Forms: one under a line, one in the file's comment zone. Nothing
        // has the focus (a caret blinks).
        await page.evaluate(({ f, l }) => window.prManager.showCommentForm(f, l, null, null, 'RIGHT'), { f: annotated, l: line(4) });
        await dom.fileWrapper(page, annotated).locator('.file-header-comment-btn').click();
        await dom.fileWrapper(page, annotated).locator('.file-comments-zone .file-comment-form textarea').waitFor({ state: 'visible', timeout: 10000 });
        await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
        await frames(4);
        await annotatedShot('forms');
        await dom.fileWrapper(page, annotated).locator('.file-comments-zone .file-comment-form .cancel-btn').click();
        // The line form's id names its first and last line (PRManager.showCommentForm).
        await page.evaluate(({ f, l }) => window.prManager.pierreBridge.removeAnnotation(f, `form-${f}-${l}-${l}-RIGHT`), { f: annotated, l: line(4) });
        // Gone, or every later shot of this position would show it.
        await dom.fileWrapper(page, annotated).locator('.user-comment-form').waitFor({ state: 'detached', timeout: 10000 });

        // The review is the next position's too: take everything off again.
        await helpers.cleanupAllComments(page, reviewId);
        await page.evaluate(() => Promise.all([window.prManager.loadUserComments(), window.prManager.loadAISuggestions()]));
        await frames(4);

        // Review threads from the pull request (PR mode): one on a line,
        // one with a reply on a later line.
        if (external) {
          external.threads = [
            helpers.externalThread({ id: 9101, file: annotated, line: line(0), body: 'A thread from the pull request.' }),
            helpers.externalThread({ id: 9201, file: annotated, line: line(2), body: 'A second thread, **with** a reply.', replies: [{ body: 'The reply.' }] }),
          ];
          await page.evaluate(() => window.prManager._loadExternalComments());
          await dom.fileWrapper(page, annotated).locator('.external-comment-row').first().waitFor({ state: 'visible', timeout: 10000 });
          await frames(4);
          await annotatedShot('external');
          external.threads = [];
          await page.evaluate(() => window.prManager._loadExternalComments());
          await dom.fileWrapper(page, annotated).locator('.external-comment-row').first().waitFor({ state: 'detached', timeout: 10000 });
          await frames(4);
        }

        // A selection of several lines, made with the pointer on the line
        // numbers of a file with no card between them.
        if (line(2) > line(0)) {
          await dom.selectLineRange(page, { file: annotated, start: line(0), end: line(2), waitForUpgrade: false });
          await annotatedShot('selection');
          await page.evaluate((f) => window.prManager.pierreBridge.clearLineSelection(f), annotated);
          await frames(2);
        }
      }

      // Positions: a tour. Its bar is above the toolbar; both are pinned
      // while the diff scrolls under them.
      if (tourStop) {
        await dom.scrollDiffToEdge(page, 'top');
        await page.locator('#tour-toggle-btn').click();
        await page.locator('.tour-bar .tour-bar__progress').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('.tour-annotation-row').first().waitFor({ state: 'visible', timeout: 10000 });
        // The tour scrolls to its stop, and corrects that scroll for a while.
        await restAt(page, 'top');
        result.tourPane = await dom.inPage(page, measurePane);
        await shoot(page, config.name, 'tour-top');
        result.positions.push('tour-top');
        await alignFile(page, long, -120);
        await shoot(page, config.name, 'tour-pinned');
        result.positions.push('tour-pinned');
        await page.locator('.tour-bar .tour-bar__exit').click();
        await page.locator('.tour-bar').waitFor({ state: 'detached', timeout: 10000 });
      }

      // Position: context files (one before the first changed file, one after the last).
      const api = await helpers.mockContextFilesApi(page, { diffFiles: order });
      for (const entry of CONTEXT_FILES) {
        for (const [line_start, line_end] of entry.ranges) api.add({ review_id: MODES[config.mode].reviewId, file: entry.file, line_start, line_end });
      }
      await page.evaluate(() => window.prManager.loadContextFiles());
      for (const entry of CONTEXT_FILES) await dom.expectContextFile(page, entry.file);
      result.context = {};
      for (const entry of CONTEXT_FILES) {
        await alignFile(page, entry.file, 40);
        result.context[entry.file] = await dom.inPage(page, measureFile, entry.file);
        const position = `context-${entry.file.split('/')[0]}`;
        await shoot(page, config.name, position);
        result.positions.push(position);
      }

      // Position: a context file with a comment in its comment zone. Its
      // lines are drawn differently (D2); its zone and the card in it are
      // compared as numbers.
      {
        const [{ file }] = CONTEXT_FILES;
        await helpers.seedComment(page, MODES[config.mode].reviewId, { file, body: 'A comment on a file outside the diff.', fileLevel: true });
        await helpers.reloadComments(page);
        await alignFile(page, file, 40);
        await page.evaluate(() => Promise.all(document.getAnimations()
          .filter((animation) => animation.effect && Number.isFinite(animation.effect.getComputedTiming().endTime))
          .map((animation) => animation.finished.catch(() => {}))));
        result.contextCards = { [file]: await dom.inPage(page, measureCards, file) };
        await shoot(page, config.name, 'context-zone');
        result.positions.push('context-zone');
        await helpers.cleanupAllComments(page, MODES[config.mode].reviewId);
      }

      await page.close();
      await upgradedStage({ context, config, corpus, order, tourStop, annotated, result, shoot, settle, alignFile });

      fs.writeFileSync(path.join(outDir, `${config.name}.json`), `${JSON.stringify(result, null, 1)}\n`);
      console.log(JSON.stringify({ capture: name, config: config.name, files: order.length, positions: result.positions.length }));
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function flatten(value, prefix = '', out = {}) {
  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

function numberDifferences(scope, kind, a, b) {
  const left = flatten(a);
  const right = flatten(b);
  const differences = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] === right[key]) continue;
    const accepted = ACCEPTED.find((entry) => entry.where === 'number' && entry.test({ kind, path: key, a: a || {}, b: b || {} }));
    differences.push({ scope, path: key, reference: left[key] ?? null, candidate: right[key] ?? null, accepted: accepted ? accepted.why : null });
  }
  return differences;
}

/* eslint-disable no-undef */
/** Runs in a blank page: two PNGs as data URLs in, the differing pixels and a side-by-side PNG out. */
async function diffImages({ a, b }) {
  const load = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.max(ia.width, ib.width);
  const h = Math.max(ia.height, ib.height);
  const pixels = (image) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  };
  const pa = pixels(ia);
  const pb = pixels(ib);
  const out = document.createElement('canvas');
  out.width = w * 3;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(ia, 0, 0);
  ctx.drawImage(ib, w, 0);
  const diff = ctx.createImageData(w, h);
  let count = 0;
  let box = null;
  const rows = new Set();
  // How far apart the two pixels are: the largest difference of a channel.
  const byDelta = {};
  const samples = [];
  for (let i = 0; i < pa.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]),
      Math.abs(pa.data[i + 2] - pb.data[i + 2]), Math.abs(pa.data[i + 3] - pb.data[i + 3]),
    );
    const same = delta === 0;
    const grey = Math.round((pa.data[i] + pa.data[i + 1] + pa.data[i + 2]) / 3 * 0.25 + 190);
    diff.data[i] = same ? grey : 255;
    diff.data[i + 1] = same ? grey : 0;
    diff.data[i + 2] = same ? grey : 0;
    diff.data[i + 3] = 255;
    if (!same) {
      count++;
      byDelta[delta] = (byDelta[delta] || 0) + 1;
      const x = (i / 4) % w;
      const y = Math.floor(i / 4 / w);
      if (samples.length < 12 && (samples.length === 0 || y > samples[samples.length - 1].y + 20)) {
        samples.push({ x, y, reference: [...pa.data.slice(i, i + 3)], candidate: [...pb.data.slice(i, i + 3)] });
      }
      rows.add(y);
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
    }
  }
  // Pixels a reader could tell apart. Text and curves are anti-aliased, and
  // the same glyph at the same place comes out a little differently when it
  // is painted in another compositing layer (the toolbar and the file headers
  // are in other layers on the two engines). So a pixel counts when its
  // value is outside the range of the 3x3 pixels around the same place in
  // the other image, by more than TOLERANCE per channel, in either
  // direction. A line or an area that is missing, added, moved by two pixels
  // or of another colour is outside that range; an anti-aliased edge is not.
  const TOLERANCE = 8;
  const outside = (p, q, i) => {
    const x = (i / 4) % w;
    const y = Math.floor(i / 4 / w);
    for (let c = 0; c < 3; c++) {
      let lo = 255;
      let hi = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = q.data[(yy * w + xx) * 4 + c];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (p.data[i + c] < lo - TOLERANCE || p.data[i + c] > hi + TOLERANCE) return true;
    }
    return false;
  };
  let visible = 0;
  let visibleBox = null;
  const visibleSamples = [];
  for (let i = 0; i < pa.data.length; i += 4) {
    if (diff.data[i + 1] !== 0) continue; // identical
    if (!outside(pa, pb, i) && !outside(pb, pa, i)) {
      diff.data[i] = 255; diff.data[i + 1] = 190; diff.data[i + 2] = 0; // differs within tolerance: amber
      continue;
    }
    visible++;
    const x = (i / 4) % w;
    const y = Math.floor(i / 4 / w);
    if (visibleSamples.length < 8 && (visibleSamples.length === 0 || y > visibleSamples[visibleSamples.length - 1].y + 4)) {
      visibleSamples.push({ x, y, reference: [...pa.data.slice(i, i + 3)], candidate: [...pb.data.slice(i, i + 3)] });
    }
    visibleBox = visibleBox ? { x0: Math.min(visibleBox.x0, x), y0: Math.min(visibleBox.y0, y), x1: Math.max(visibleBox.x1, x), y1: Math.max(visibleBox.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
  }
  ctx.putImageData(diff, w * 2, 0);
  return { count, visible, visibleBox, visibleSamples, byDelta, samples, box, rows: rows.size, sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height], png: out.toDataURL('image/png') };
}
/* eslint-enable no-undef */

async function compare(args) {
  const sides = [args.reference || path.join(args.out, 'reference'), path.join(args.out, 'candidate')];
  const compareDir = path.join(args.out, 'compare');
  fs.mkdirSync(compareDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report = { numbers: [], pixels: [] };
  try {
    for (const config of configsOf(args)) {
      const [a, b] = sides.map((dir) => JSON.parse(fs.readFileSync(path.join(dir, `${config.name}.json`), 'utf8')));
      const scope = (what) => `${config.name} ${what}`;
      if (JSON.stringify(a.order) !== JSON.stringify(b.order)) report.numbers.push({ scope: scope('order'), path: 'order', reference: a.order.length, candidate: b.order.length, accepted: null });
      report.numbers.push(...numberDifferences(scope('pane'), 'pane', a.pane, b.pane));
      report.numbers.push(...numberDifferences(scope('pane during a tour'), 'pane', a.tourPane, b.tourPane));
      for (const file of a.order) report.numbers.push(...numberDifferences(scope(file), 'diff', a.files[file], b.files[file]));
      report.numbers.push(...numberDifferences(scope(`collapsed ${a.collapsed.file}`), 'diff', a.collapsed.geometry, b.collapsed.geometry));
      for (const file of Object.keys(a.context)) report.numbers.push(...numberDifferences(scope(`context ${file}`), 'context', a.context[file], b.context[file]));
      report.numbers.push(...numberDifferences(scope('end of the pane'), 'end', a.end, b.end));
      for (const position of Object.keys(a.cards || {})) report.numbers.push(...numberDifferences(scope(`${position} on the annotated file`), 'cards', a.cards[position], (b.cards || {})[position]));
      for (const file of Object.keys(a.contextCards || {})) report.numbers.push(...numberDifferences(scope(`comment zone of context ${file}`), 'contextCards', a.contextCards[file], (b.contextCards || {})[file]));
      // With the file contents loaded: every file, the gap as it is expanded, the landings.
      const upgradedA = a.upgraded || { files: {}, gap: {}, landings: {} };
      const upgradedB = b.upgraded || { files: {}, gap: {}, landings: {} };
      for (const file of Object.keys(upgradedA.files)) report.numbers.push(...numberDifferences(scope(`${file} with its contents loaded`), 'upgraded', upgradedA.files[file], upgradedB.files[file]));
      for (const state of Object.keys(upgradedA.gap)) report.numbers.push(...numberDifferences(scope(`gap ${state}`), 'gap', upgradedA.gap[state], upgradedB.gap[state]));
      for (const name of Object.keys(upgradedA.landings)) report.numbers.push(...numberDifferences(scope(`landing ${name}`), 'landing', upgradedA.landings[name], upgradedB.landings[name]));

      for (const position of a.positions) {
        const data = sides.map((dir) => `data:image/png;base64,${fs.readFileSync(path.join(dir, `${config.name}.${position}.png`)).toString('base64')}`);
        const result = await page.evaluate(diffImages, { a: data[0], b: data[1] });
        fs.writeFileSync(path.join(compareDir, `${config.name}.${position}.png`), Buffer.from(result.png.split(',')[1], 'base64'));
        const compared = !position.startsWith('context-');
        const decided = ACCEPTED.find((entry) => entry.where === 'pixels' && entry.test({ config, position, visible: result.visible }));
        report.pixels.push({
          scope: `${config.name} ${position}`,
          differing: result.count,
          visible: result.visible,
          visibleBox: result.visibleBox,
          visibleSamples: result.visibleSamples,
          byDelta: result.byDelta,
          samples: result.samples,
          rows: result.rows,
          box: result.box,
          accepted: compared ? (decided ? decided.why : null) : 'D2: a context file\'s lines are drawn by the viewer; saved for the eye, not compared',
        });
      }
    }
  } finally {
    await browser.close();
  }

  const failedNumbers = report.numbers.filter((d) => !d.accepted);
  const failedPixels = report.pixels.filter((p) => p.visible > 0 && !p.accepted);
  const lines = [];
  lines.push(`numbers: ${report.numbers.length} difference(s), ${failedNumbers.length} not accepted`);
  const byPath = new Map();
  for (const d of report.numbers) {
    const key = `${d.accepted ? 'accepted' : 'DIFFERENT'} ${d.path}: reference ${JSON.stringify(d.reference)} / this tree ${JSON.stringify(d.candidate)}`;
    byPath.set(key, [...(byPath.get(key) || []), d.scope]);
  }
  for (const [key, scopes] of [...byPath].sort()) lines.push(`  ${key}  [${scopes.length}x, e.g. ${scopes[0]}]`);
  lines.push(`pixels: ${report.pixels.length} screenshot pair(s); ${failedPixels.length} compared pair(s) have a pixel a reader could tell apart`);
  lines.push('  (per pair: pixels that are not identical, by how far apart the two values are; and of those, the ones outside the');
  lines.push('   anti-aliasing tolerance, which is what fails)');
  for (const p of report.pixels) {
    const state = p.accepted
      ? (p.accepted.startsWith('D2') ? 'not compared' : (p.visible > 0 ? 'accepted' : 'equal'))
      : (p.visible > 0 ? 'DIFFERENT' : (p.differing === 0 ? 'identical' : 'equal'));
    const far = Object.entries(p.byDelta || {}).reduce((n, [delta, count]) => n + (Number(delta) > 2 ? count : 0), 0);
    lines.push(`  ${state} ${p.scope}: ${p.differing} px not identical (${p.differing - far} by 1-2 of 255, ${far} by more), ${p.visible} outside tolerance${p.visibleBox ? ` box ${p.visibleBox.x0},${p.visibleBox.y0}..${p.visibleBox.x1},${p.visibleBox.y1}` : ''}`);
    if (p.visible && !p.accepted) for (const sample of p.visibleSamples.slice(0, 6)) lines.push(`      at ${sample.x},${sample.y}: reference rgb(${sample.reference}) / this tree rgb(${sample.candidate})`);
  }
  fs.writeFileSync(path.join(args.out, 'REPORT.json'), `${JSON.stringify(report, null, 1)}\n`);
  fs.writeFileSync(path.join(args.out, 'REPORT.txt'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  return failedNumbers.length + failedPixels.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.capture) {
    await capture(args, args.capture);
    return;
  }
  fs.mkdirSync(args.out, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  // What the captures are told: where to write and which configurations.
  const matrix = ['--out', path.resolve(args.out), '--corpus', args.corpus.join(','), '--mode', args.mode.join(','), '--style', args.style.join(','), '--theme', args.theme.join(',')];
  if (!process.env.VISUAL_COMPARE_ONLY) {
    if (args['reference-checkout']) {
      const checkout = path.resolve(args['reference-checkout']);
      const script = path.join(checkout, 'tests', 'parity', 'visual.mjs');
      if (!fs.existsSync(script)) throw new Error(`${checkout} has no tests/parity/visual.mjs`);
      const child = spawnSync(process.execPath, [script, ...matrix, '--capture', 'reference'], { cwd: checkout, env: captureEnvironment(), stdio: 'inherit' });
      if (child.status !== 0) throw new Error(`capture of the reference checkout failed (exit ${child.status})`);
    }
    const child = spawnSync(process.execPath, [self, ...matrix, '--capture', 'candidate'], { stdio: 'inherit' });
    if (child.status !== 0) throw new Error(`capture of this tree failed (exit ${child.status})`);
  }
  const failures = await compare(args);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
