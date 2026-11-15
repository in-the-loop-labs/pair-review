// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Visual parity of the diff pane between the two diff engines (layer L4 of
 * plans/codeview-virtualized-diff.md, next to the golden dump).
 *
 * The golden dump compares what a file's rows SAY. This script compares how
 * the pane LOOKS: for every changed file its geometry as numbers (header box
 * and the boxes of what is in it, the distance from the header to the first
 * row, the file's frame, the space to the next file, gutter width, row height,
 * fonts), and the pane as pixels at fixed positions (top of the pane, a file
 * header pinned over a hunk, a collapsed file, the end of the pane, a context
 * file).
 *
 * Both engines are opened against one test server in one run, with the
 * file-contents requests held back, so every changed file shows the rows of
 * its patch on both engines and the two screenshots of a position can be
 * compared pixel by pixel. A context file is drawn differently by decision D2;
 * its screenshots are saved and its pixels are not compared (its header,
 * frame and place are compared as numbers).
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=... node tests/parity/visual.mjs --out <dir>
 *     [--corpus default,edge] [--mode pr,local] [--style unified,split] [--theme light,dark]
 *
 * Writes <out>/<engine>/<config>.json and <config>.<position>.png per engine,
 * <out>/compare/<config>.<position>.png (default engine, codeview, and the
 * pixels that differ, side by side: red outside the anti-aliasing tolerance,
 * amber within it), <out>/REPORT.json and <out>/REPORT.txt.
 * Exit code 1 when a number differs and is not in ACCEPTED below, or a
 * compared screenshot has a pixel outside the tolerance (see diffImages).
 *
 * With VISUAL_COMPARE_ONLY=1 the two captures already in <out> are compared
 * again and nothing is captured.
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
const ENGINES = ['filediff', 'codeview'];
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
 *   where: 'number' (a geometry path) or 'pixels' (a position)
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
    where: 'number',
    test: ({ kind, path: key, a, b }) => kind === 'diff' && key === 'frame.bottom' && a.frame && b.frame && a.frame.h === 1 && b.frame.h === 1,
    why: 'a diff without a line: the 1 px line under the header is the empty code block\'s bottom border on the default engine and is drawn in the file\'s comment zone on codeview (the viewer counts no bottom padding for an item without lines); the pixels are compared',
  },
];

function parseArgs(argv) {
  const args = { corpus: ['default', 'edge'], mode: ['pr', 'local'], style: ['unified', 'split'], theme: ['light', 'dark'], out: null, capture: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in args) || value === undefined) throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    args[key] = key === 'out' || key === 'capture' ? value : value.split(',');
    i++;
  }
  if (!args.out) throw new Error('--out <dir> is required');
  return args;
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
// Capture (one engine per process: tests/e2e/diff-dom.js picks its engine half
// from PR_ENGINE when it is loaded)
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
  // separators, or the rows of a table.
  let content = [];
  if (!collapsed) {
    if (shadow) content = [...shadow.querySelectorAll('[data-line], [data-separator]')];
    if (content.length === 0) content = [...wrapper.querySelectorAll('tbody tr')];
    content = content.filter((el) => el.getBoundingClientRect().height > 0);
  }
  const tops = content.map((el) => el.getBoundingClientRect().top);
  const bottoms = content.map((el) => el.getBoundingClientRect().bottom);
  const headerBox = header ? header.getBoundingClientRect() : null;

  // The first line of code and its number cell.
  const firstLine = shadow ? shadow.querySelector('[data-content] [data-line], [data-line]') : wrapper.querySelector('tbody tr td:last-child');
  const firstNumber = shadow ? shadow.querySelector('[data-column-number]') : wrapper.querySelector('tbody tr td:first-child');

  // The frame: the element that draws a border around the file's lines.
  const frameCandidates = [
    wrapper.querySelector('.pierre-diff-body'),
    shadow && shadow.querySelector('pre[data-diff]'),
    wrapper.querySelector('.d2h-file-body'),
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
  };
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

async function capture(args, engine) {
  const { startTestServer } = require('../e2e/test-server.js');
  const corpora = require('../e2e/fixtures/diffs.js');
  const dom = require('../e2e/diff-dom.js');
  const helpers = require('../e2e/helpers.js');
  const outDir = path.join(args.out, engine);
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
  const shoot = async (page, name, position) => {
    // The pointer is parked outside the pane: no hover state in any shot.
    await page.mouse.move(2, 2);
    await settle(page);
    await page.locator('.diff-view').screenshot({ path: path.join(outDir, `${name}.${position}.png`), animations: 'disabled' });
  };

  try {
    for (const config of configsOf(args)) {
      const corpus = corpora.allCorpora()[config.corpusName];
      if (!corpus) throw new Error(`Unknown corpus "${config.corpusName}"`);
      const context = await browser.newContext({ baseURL, viewport: VIEWPORT });
      await context.addInitScript(({ style, theme, eng }) => {
        window.localStorage.setItem('pair-review-diff-view', style);
        window.localStorage.setItem('theme', theme);
        if (eng) window.__PAIR_REVIEW_DIFF_ENGINE = eng;
      }, { style: config.style, theme: config.theme, eng: engine === 'codeview' ? 'codeview' : null });
      const page = await context.newPage();
      await corpora.routeDiff(page, corpus);
      const tourStop = TOUR_STOP[config.corpusName] || null;
      if (tourStop) {
        await helpers.mockAppConfig(page, { tours: { enabled: true } });
        await helpers.mockTour(page, [{ ...tourStop, title: 'A stop', description: 'A stop of the tour.' }]);
      }
      // Held for the whole run: every changed file shows the rows of its
      // patch on both engines.
      await page.route(/\/api\/reviews\/\d+\/file-contents\//, () => {});
      await page.goto(`${baseURL}${MODES[config.mode].path}`);
      await page.waitForSelector('#diff-container .d2h-file-wrapper[data-file-name]', { timeout: 15000 });
      await dom.waitForDiffSettled(page).catch(() => {});
      const order = (await dom.filesInPane(page)).filter((e) => e.kind === 'diff').map((e) => e.file);
      const result = { meta: { ...config, engine, viewport: `${VIEWPORT.width}x${VIEWPORT.height}` }, order, files: {}, positions: [] };

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

      // Position: the end of the pane.
      await dom.scrollDiffToEdge(page, 'bottom');
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

      fs.writeFileSync(path.join(outDir, `${config.name}.json`), `${JSON.stringify(result, null, 1)}\n`);
      console.log(JSON.stringify({ engine, config: config.name, files: order.length, positions: result.positions.length }));
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
    differences.push({ scope, path: key, filediff: left[key] ?? null, codeview: right[key] ?? null, accepted: accepted ? accepted.why : null });
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
        samples.push({ x, y, filediff: [...pa.data.slice(i, i + 3)], codeview: [...pb.data.slice(i, i + 3)] });
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
      visibleSamples.push({ x, y, filediff: [...pa.data.slice(i, i + 3)], codeview: [...pb.data.slice(i, i + 3)] });
    }
    visibleBox = visibleBox ? { x0: Math.min(visibleBox.x0, x), y0: Math.min(visibleBox.y0, y), x1: Math.max(visibleBox.x1, x), y1: Math.max(visibleBox.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
  }
  ctx.putImageData(diff, w * 2, 0);
  return { count, visible, visibleBox, visibleSamples, byDelta, samples, box, rows: rows.size, sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height], png: out.toDataURL('image/png') };
}
/* eslint-enable no-undef */

async function compare(args) {
  const compareDir = path.join(args.out, 'compare');
  fs.mkdirSync(compareDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report = { numbers: [], pixels: [] };
  try {
    for (const config of configsOf(args)) {
      const [a, b] = ENGINES.map((engine) => JSON.parse(fs.readFileSync(path.join(args.out, engine, `${config.name}.json`), 'utf8')));
      const scope = (what) => `${config.name} ${what}`;
      if (JSON.stringify(a.order) !== JSON.stringify(b.order)) report.numbers.push({ scope: scope('order'), path: 'order', filediff: a.order.length, codeview: b.order.length, accepted: null });
      report.numbers.push(...numberDifferences(scope('pane'), 'pane', a.pane, b.pane));
      report.numbers.push(...numberDifferences(scope('pane during a tour'), 'pane', a.tourPane, b.tourPane));
      for (const file of a.order) report.numbers.push(...numberDifferences(scope(file), 'diff', a.files[file], b.files[file]));
      report.numbers.push(...numberDifferences(scope(`collapsed ${a.collapsed.file}`), 'diff', a.collapsed.geometry, b.collapsed.geometry));
      for (const file of Object.keys(a.context)) report.numbers.push(...numberDifferences(scope(`context ${file}`), 'context', a.context[file], b.context[file]));

      for (const position of a.positions) {
        const data = ENGINES.map((engine) => `data:image/png;base64,${fs.readFileSync(path.join(args.out, engine, `${config.name}.${position}.png`)).toString('base64')}`);
        const result = await page.evaluate(diffImages, { a: data[0], b: data[1] });
        fs.writeFileSync(path.join(compareDir, `${config.name}.${position}.png`), Buffer.from(result.png.split(',')[1], 'base64'));
        const compared = !position.startsWith('context-');
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
          accepted: compared ? null : 'D2: a context file\'s lines are drawn by the viewer; saved for the eye, not compared',
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
    const key = `${d.accepted ? 'accepted' : 'DIFFERENT'} ${d.path}: default ${JSON.stringify(d.filediff)} / codeview ${JSON.stringify(d.codeview)}`;
    byPath.set(key, [...(byPath.get(key) || []), d.scope]);
  }
  for (const [key, scopes] of [...byPath].sort()) lines.push(`  ${key}  [${scopes.length}x, e.g. ${scopes[0]}]`);
  lines.push(`pixels: ${report.pixels.length} screenshot pair(s); ${failedPixels.length} compared pair(s) have a pixel a reader could tell apart`);
  lines.push('  (per pair: pixels that are not identical, by how far apart the two values are; and of those, the ones outside the');
  lines.push('   anti-aliasing tolerance, which is what fails)');
  for (const p of report.pixels) {
    const state = p.accepted ? 'not compared' : (p.visible > 0 ? 'DIFFERENT' : (p.differing === 0 ? 'identical' : 'equal'));
    const far = Object.entries(p.byDelta || {}).reduce((n, [delta, count]) => n + (Number(delta) > 2 ? count : 0), 0);
    lines.push(`  ${state} ${p.scope}: ${p.differing} px not identical (${p.differing - far} by 1-2 of 255, ${far} by more), ${p.visible} outside tolerance${p.visibleBox ? ` box ${p.visibleBox.x0},${p.visibleBox.y0}..${p.visibleBox.x1},${p.visibleBox.y1}` : ''}`);
    if (p.visible && !p.accepted) for (const sample of p.visibleSamples.slice(0, 6)) lines.push(`      at ${sample.x},${sample.y}: default rgb(${sample.filediff}) / codeview rgb(${sample.codeview})`);
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
  for (const engine of process.env.VISUAL_COMPARE_ONLY ? [] : ENGINES) {
    const env = { ...process.env };
    if (engine === 'codeview') env.PR_ENGINE = 'codeview';
    else delete env.PR_ENGINE;
    const child = spawnSync(process.execPath, [self, ...process.argv.slice(2), '--capture', engine], { env, stdio: 'inherit' });
    if (child.status !== 0) throw new Error(`capture of the ${engine} engine failed (exit ${child.status})`);
  }
  const failures = await compare(args);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
