// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Golden render dump (layer L4 of plans/codeview-virtualized-diff.md).
 *
 * Opens the real application against the E2E test server, walks every file of
 * a corpus by real scrolling of the diff's scroll container, and writes what a
 * reader sees of each file as JSON: rows (column, type, line numbers, text),
 * separators, expand controls, header state, and each annotation's slot.
 *
 * Two stages per page:
 *   pre   the diff as rendered from the patch alone (file-contents requests
 *         are held back, so no file has been upgraded with its contents)
 *   post  after the held requests are released and every upgrade has landed
 *
 * A third stage, `annotated`, dumps one file with a line comment, a
 * file-level comment and an AI suggestion on it (annotation slots and cards).
 *
 * It also measures landings: where a file's header ends up after a sidebar
 * click, and after collapsing the file while scrolled deep inside it; and
 * where a suggestion's card ends up after a click on it in the review panel.
 *
 * The dump is taken once per engine and compared with compare.mjs. Everything
 * that reads the rendered diff goes through tests/e2e/diff-dom.js, so the
 * same script runs against either engine (PR_ENGINE=codeview from phase 5).
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=... node tests/parity/dump.mjs --out <dir>
 *     [--corpus default,eviction,many,edge] [--mode pr,local]
 *     [--style unified,split] [--theme light,dark]
 *
 * Binds a kernel-assigned port (never 4000+n, which the E2E suite uses), but
 * it is a second browser all the same: do not run it while the E2E suite is
 * running, or both get slower and flakier.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
process.env.PAIR_REVIEW_NO_OPEN = '1';
const { startTestServer } = require('../e2e/test-server.js');
const corpora = require('../e2e/fixtures/diffs.js');
const dom = require('../e2e/diff-dom.js');
const helpers = require('../e2e/helpers.js');

const MODES = {
  pr: { path: '/pr/test-owner/test-repo/1', reviewId: 1 },
  local: { path: '/local/2', reviewId: 2 },
};

function parseArgs(argv) {
  const args = { corpus: ['default', 'eviction', 'many', 'edge'], mode: ['pr', 'local'], style: ['unified', 'split'], theme: ['light', 'dark'], out: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in args) || value === undefined) throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    args[key] = key === 'out' ? value : value.split(',');
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

/** Scroll the diff so `file`'s header is at the top of the visible area, by setting the container's scrollTop. */
async function scrollToFileTop(page, file) {
  await dom.inPage(page, (D, f) => {
    const s = D.scroller();
    const w = D.wrapper(f) || D.contextWrapper(f);
    if (!w) return;
    s.scrollTop += w.getBoundingClientRect().top - s.getBoundingClientRect().top;
  }, file);
}

/**
 * Wait until what is on screen for `file` has stopped changing: the same dump
 * on three consecutive animation frames' worth of polls.
 */
async function settledDump(page, file, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  let previous = null;
  let same = 0;
  for (;;) {
    const current = JSON.stringify(await dom.dumpFile(page, file));
    same = current === previous ? same + 1 : 0;
    previous = current;
    if (same >= 3) return JSON.parse(current);
    if (Date.now() > deadline) return { ...JSON.parse(current), unsettled: true };
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}

async function dumpAllFiles(page, order, { requireUpgrade = false } = {}) {
  const files = {};
  for (const file of order) {
    await scrollToFileTop(page, file);
    if (requireUpgrade) {
      // Ask for this file's upgrade (the path a reveal takes) and wait until
      // it is displayed. Waiting for "upgraded, or nothing queued or in
      // flight" is not enough: nothing is queued or in flight for a file the
      // background queue has not started on either, and the post stage then
      // recorded that file as it was before its upgrade (once in two full
      // dumps). Files that are never upgraded (binary, too large, no patch)
      // answer false and settle as they are.
      await dom.ensureContentUpgrade(page, file).catch(() => false);
      await dom.waitForFileSettled(page, file).catch(() => {});
    }
    files[file] = await settledDump(page, file);
  }
  return files;
}

async function measureLandings(page, corpus) {
  const landings = {};
  const sortedOrder = (await dom.filesInPane(page)).filter((e) => e.kind === 'diff').map((e) => e.file);
  // The jump target is the corpus's `target` file, or the file in the middle
  // of the pane. Not the last file: whether the last file can reach the top
  // depends on the scroll extent below it, and on the current engine that
  // extent was not the same from one run to the next (edge corpus, PR mode:
  // the header landed flush in one dump and 365 px lower, at the end of the
  // diff, in the next).
  const target = corpus.order.includes(corpus.roles.target)
    ? corpus.roles.target
    : sortedOrder[Math.floor((sortedOrder.length - 1) / 2)];
  const reference = sortedOrder[0];

  /**
   * A file's header position once it has been the same for 40 frames. The
   * application's navigation scrolls smoothly, pauses, measures and corrects
   * (its settle loop), so a position that has held for a few frames can
   * still move; and the next measurement must not start under a navigation
   * that is still correcting.
   */
  const settledHeaderTop = async (file) => {
    let last = null;
    let same = 0;
    const deadline = Date.now() + 15000;
    while (same < 40 && Date.now() < deadline) {
      const position = await dom.headerPosition(page, file);
      const top = position ? Math.round(position.top * 100) / 100 : null;
      same = top === last ? same + 1 : 0;
      last = top;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    return last;
  };
  /**
   * Put a file on screen and wait until it shows what it is going to show.
   * A landing depends on heights (whether the last file can reach the top,
   * where the scroll is clamped after a collapse), and a file's height
   * changes when its contents arrive; measuring before that is measuring a
   * race.
   */
  const settleFile = async (file) => {
    await scrollToFileTop(page, file);
    await dom.waitForFileSettled(page, file).catch(() => {});
    await settledDump(page, file);
  };

  // 1. Sidebar jump: header position of the target once the scroll has settled.
  await settleFile(target);
  await dom.scrollDiffToEdge(page, 'top');
  const item = page.locator(`.file-item[data-path=${JSON.stringify(target)}]`).first();
  if (await item.count()) {
    await item.click();
    const headerTop = await settledHeaderTop(target);
    const scroll = await dom.scrollState(page);
    landings.sidebarJump = { file: target, headerTop, atEnd: scroll.top + scroll.client >= scroll.height - 2 };
  }

  // 2. Collapse while scrolled inside a file: where its header is afterwards.
  const tall = corpus.roles.big || corpus.roles.twoHunks || reference;
  await settleFile(tall);
  await scrollToFileTop(page, tall);
  const before = await dom.scrollState(page);
  await dom.scrollDiffTo(page, before.top + 300);
  const wrapper = dom.fileWrapper(page, tall);
  if (await wrapper.count()) {
    await page.evaluate((f) => window.prManager.toggleFileCollapse(f), tall);
    const headerTop = await settledHeaderTop(tall);
    landings.collapseInside = { file: tall, scrolledInsideBy: 300, headerTop };
    await page.evaluate((f) => window.prManager.toggleFileCollapse(f), tall);
  }
  return landings;
}

/**
 * The annotated stage: one line comment, one file-level comment and one AI
 * suggestion on the first file of the corpus that has added lines, dumped
 * with its annotation slots, plus where the suggestion's card lands after a
 * click on it in the review panel from the top of the diff.
 *
 * Ids are replaced by what the card is, so two dumps compare equal whatever
 * the database handed out.
 */
async function dumpAnnotated(page, corpus, order, reviewId) {
  const file = order.find((path) => {
    const info = corpus.files[path];
    return info && !info.binary && !corpus.generated.includes(path)
      && corpora.changedLines(corpus, path).additions.length >= 2;
  });
  if (!file) return { annotated: null, landing: null };
  const { additions } = corpora.changedLines(corpus, file);
  const commentLine = additions[0];
  const suggestionLine = additions[additions.length - 1];

  const commentId = await helpers.seedComment(page, reviewId, { file, line: commentLine, body: 'Golden line comment' });
  const fileCommentId = await helpers.seedComment(page, reviewId, { file, body: 'Golden file comment', fileLevel: true });
  await helpers.reloadComments(page);
  const [suggestionId] = await helpers.seedSuggestions(page, reviewId, [
    { file, line_start: suggestionLine, title: 'Golden suggestion', body: 'Golden suggestion body' },
  ]);
  await scrollToFileTop(page, file);
  await dom.inlineComment(page, commentId).waitFor({ state: 'attached', timeout: 15000 });
  await dom.inlineSuggestion(page, suggestionId).waitFor({ state: 'attached', timeout: 15000 });
  const dump = await settledDump(page, file);
  const names = { [commentId]: 'line-comment', [fileCommentId]: 'file-comment', [suggestionId]: 'suggestion' };
  for (const slot of dump.annotations) {
    for (const card of slot.cards) {
      if (card.commentId) card.commentId = names[card.commentId] || 'other';
      if (card.suggestionId) card.suggestionId = names[card.suggestionId] || 'other';
    }
  }
  const zone = dom.fileWrapper(page, file).locator('.file-comment-card');
  dump.fileCommentCards = await zone.count();

  // Landing of the suggestion's card after a click in the review panel.
  await dom.scrollDiffToEdge(page, 'top');
  await page.evaluate(() => window.aiPanel && window.aiPanel.expand());
  const item = page.locator(`.finding-item[data-id="${suggestionId}"]`);
  await item.waitFor({ state: 'visible', timeout: 10000 });
  await item.click();
  const card = dom.inlineSuggestion(page, suggestionId);
  await card.waitFor({ state: 'visible', timeout: 15000 });
  let last = null;
  let same = 0;
  const deadline = Date.now() + 15000;
  while (same < 40 && Date.now() < deadline) {
    const box = await card.boundingBox();
    const pinned = await dom.inPage(page, (D) => D.pinnedBottom());
    const below = box ? Math.round((box.y - pinned) * 100) / 100 : null;
    same = below === last ? same + 1 : 0;
    last = below;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await helpers.cleanupAllComments(page, reviewId);
  return {
    annotated: { [file]: dump },
    landing: { file, line: suggestionLine, cardBelowPinned: last },
  };
}

async function dumpOne(browser, baseURL, { corpusName, mode, style, theme }) {
  const corpus = corpora.allCorpora()[corpusName];
  if (!corpus) throw new Error(`Unknown corpus "${corpusName}"`);
  // baseURL: the shared cleanup helpers also talk to the server through
  // page.request, with relative URLs.
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  context.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
  });
  await context.addInitScript(({ style: s, theme: t, engine }) => {
    window.localStorage.setItem('pair-review-diff-view', s);
    window.localStorage.setItem('theme', t);
    if (engine) window.__PAIR_REVIEW_DIFF_ENGINE = engine;
  }, { style, theme, engine: process.env.PR_ENGINE === 'codeview' ? 'codeview' : null });
  const page = await context.newPage();

  await corpora.routeDiff(page, corpus);
  // Hold every file-contents request until the pre-upgrade stage is dumped.
  const held = [];
  let holding = true;
  await page.route(/\/api\/reviews\/\d+\/file-contents\//, (route) => {
    if (holding) held.push(route);
    else route.fallback();
  });

  await page.goto(`${baseURL}${MODES[mode].path}`);
  await page.waitForSelector('#diff-container .d2h-file-wrapper[data-file-name]', { timeout: 15000 });
  const order = (await dom.filesInPane(page)).filter((e) => e.kind === 'diff').map((e) => e.file);

  const pre = await dumpAllFiles(page, order);

  holding = false;
  for (const route of held.splice(0)) await route.fallback().catch(() => {});
  await dom.scrollDiffToEdge(page, 'top');
  const post = await dumpAllFiles(page, order, { requireUpgrade: true });
  const landings = await measureLandings(page, corpus);
  const { annotated, landing } = await dumpAnnotated(page, corpus, order, MODES[mode].reviewId);
  if (landing) landings.aiPanelClick = landing;

  await context.close();
  return {
    meta: { corpus: corpusName, mode, style, theme, engine: process.env.PR_ENGINE || 'filediff', viewport: '1440x900' },
    order,
    pre,
    post,
    annotated,
    landings,
    consoleErrors: consoleErrors.filter((text) => !/WebSocket connection|Failed to fetch|spawnSync|Failed to load resource/.test(text)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const { server, db, port } = await startTestServer(await freePort());
  const browser = await chromium.launch({ headless: true });
  const summary = [];
  try {
    for (const corpusName of args.corpus) {
      for (const mode of args.mode) {
        for (const style of args.style) {
          for (const theme of args.theme) {
            const started = Date.now();
            const result = await dumpOne(browser, `http://localhost:${port}`, { corpusName, mode, style, theme });
            const file = path.join(args.out, `${corpusName}.${mode}.${style}.${theme}.json`);
            fs.writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);
            const rowsOf = (stage) => Object.values(stage).reduce((n, f) => n + (f ? f.columns.reduce((m, c) => m + c.rows.length, 0) : 0), 0);
            const line = {
              file: path.basename(file),
              files: result.order.length,
              preRows: rowsOf(result.pre),
              postRows: rowsOf(result.post),
              unsettled: [...Object.values(result.pre), ...Object.values(result.post)].filter((f) => f && f.unsettled).length,
              consoleErrors: result.consoleErrors.length,
              ms: Date.now() - started,
            };
            summary.push(line);
            console.log(JSON.stringify(line));
          }
        }
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch { /* already closed */ }
  }
  fs.writeFileSync(path.join(args.out, 'SUMMARY.json'), `${JSON.stringify(summary, null, 1)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
