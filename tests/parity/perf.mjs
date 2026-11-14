// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Performance baseline (layer L6 of plans/codeview-virtualized-diff.md).
 *
 * Opens the real application against the E2E test server and measures, per
 * mode, medians over N runs (default 5) of:
 *
 *   firstRowMs       navigation start to the first code row on screen
 *                    (60-file corpus)
 *   hostsAtRest      diff hosts in the DOM once the page has loaded and gone
 *                    idle; hostsAfterScroll the same after scrolling through
 *                    the whole diff (how much DOM the engine keeps mounted)
 *   scroll           a scripted wheel scroll through the 60-file diff: long
 *                    tasks (count, total and longest, ms) and frame intervals
 *                    (p50, p95, max, ms)
 *   revealMs         from asking for a line hidden between two hunks to that
 *                    line's row being on screen (gate G12's measure, on the
 *                    300-line target file of the eviction corpus)
 *
 * The same script is run for each engine (PR_ENGINE=codeview from phase 5)
 * and the two results compared. Everything that reads the rendered diff goes
 * through tests/e2e/diff-dom.js. CSS transitions are on, as in production.
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=... node tests/parity/perf.mjs --out <file.json> [--runs 5] [--mode pr,local]
 *
 * Numbers are only comparable between runs on the same machine under the
 * same load: take both engines' numbers in one sitting, and never while the
 * E2E suite is running.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
process.env.PAIR_REVIEW_NO_OPEN = '1';
const { startTestServer } = require('../e2e/test-server.js');
const corpora = require('../e2e/fixtures/diffs.js');
const dom = require('../e2e/diff-dom.js');

const MODES = { pr: '/pr/test-owner/test-repo/1', local: '/local/2' };

function parseArgs(argv) {
  const args = { out: null, runs: 5, mode: ['pr', 'local'] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in args) || value === undefined) throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    args[key] = key === 'out' ? value : key === 'runs' ? Number(value) : value.split(',');
  }
  if (!args.out) throw new Error('--out <file.json> is required');
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

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (value) => Math.round(value * 10) / 10;

async function newPage(browser, baseURL) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  if (process.env.PR_ENGINE === 'codeview') {
    await context.addInitScript(() => { window.__PAIR_REVIEW_DIFF_ENGINE = 'codeview'; });
  }
  const page = await context.newPage();
  return { context, page };
}

/** Load the 60-file corpus: time to first row, hosts at rest, then a scripted wheel scroll. */
async function measureLoadAndScroll(browser, baseURL, modePath) {
  const corpus = corpora.allCorpora().many;
  const { context, page } = await newPage(browser, baseURL);
  await corpora.routeDiff(page, corpus);
  const started = Date.now();
  await page.goto(modePath);
  await dom.waitForDiffToRender(page, 30000);
  const firstRowMs = Date.now() - started;
  await dom.waitForContentUpgrade(page, undefined, { timeout: 60000 });
  const hostsAtRest = await dom.inPage(page, (D) => D.hosts().length);

  // Park the pointer on the diff and scroll with real wheel events.
  await page.mouse.move(700, 500);
  await page.evaluate(() => {
    const perf = { longTasks: [], frames: [], running: true, last: performance.now() };
    perf.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longTasks.push(entry.duration);
    });
    perf.observer.observe({ entryTypes: ['longtask'] });
    const tick = (now) => {
      perf.frames.push(now - perf.last);
      perf.last = now;
      if (perf.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__perf = perf;
  });
  const steps = 160;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 400);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  const scroll = await page.evaluate(() => {
    const perf = window.__perf;
    perf.running = false;
    perf.observer.disconnect();
    const frames = perf.frames.slice(1).sort((a, b) => a - b);
    const at = (q) => frames[Math.min(frames.length - 1, Math.floor(frames.length * q))];
    return {
      longTaskCount: perf.longTasks.length,
      longTaskTotalMs: perf.longTasks.reduce((sum, d) => sum + d, 0),
      longTaskMaxMs: perf.longTasks.reduce((max, d) => Math.max(max, d), 0),
      frameP50Ms: at(0.5),
      frameP95Ms: at(0.95),
      frameMaxMs: frames[frames.length - 1],
    };
  });
  const state = await dom.scrollState(page);
  scroll.scrolledPx = Math.round(state.top);
  const hostsAfterScroll = await dom.inPage(page, (D) => D.hosts().length);
  await context.close();
  return { firstRowMs, hostsAtRest, hostsAfterScroll, ...scroll };
}

/** Reveal a hidden line of the eviction corpus's target file and time it to the row being on screen. */
async function measureReveal(browser, baseURL, modePath) {
  const corpus = corpora.allCorpora().eviction;
  const file = corpus.roles.target;
  const { hunks } = corpora.changedLines(corpus, file);
  const line = Math.floor((hunks[0].newStart + hunks[0].newCount + hunks[1].newStart) / 2);
  const { context, page } = await newPage(browser, baseURL);
  await corpora.routeDiff(page, corpus);
  await page.goto(modePath);
  await dom.waitForDiffToRender(page, 30000);
  await dom.waitForFileRendered(page, file);
  await dom.waitForContentUpgrade(page, file);
  if (await dom.isLineVisible(page, file, line)) throw new Error(`perf: line ${line} of ${file} is not hidden`);
  const revealMs = await dom.inPage(page, async (D, a) => {
    const started = performance.now();
    // Not awaited before the measurement: the call resolves when the data
    // says the line is visible, and the row is drawn after that.
    const requested = window.prManager.ensureLinesVisible([{ file: a.file, line_start: a.line, line_end: a.line, side: 'RIGHT' }]);
    let elapsed = null;
    while (elapsed === null) {
      if (D.rowBox(a.file, a.line, 'additions')) elapsed = performance.now() - started;
      else if (performance.now() - started > 20000) throw new Error('perf: the revealed row never appeared');
      else await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await requested;
    return elapsed;
  }, { file, line });
  await context.close();
  return { revealMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { server, port } = await startTestServer(await freePort());
  const browser = await chromium.launch();
  const baseURL = `http://localhost:${port}`;
  const result = {
    meta: {
      engine: process.env.PR_ENGINE || 'filediff',
      runs: args.runs,
      viewport: '1440x900',
      date: new Date().toISOString(),
      loadAverageStart: os.loadavg().map(round),
      cpus: os.cpus().length,
    },
    modes: {},
  };
  try {
    for (const mode of args.mode) {
      const samples = [];
      for (let run = 0; run < args.runs; run++) {
        const load = await measureLoadAndScroll(browser, baseURL, MODES[mode]);
        const reveal = await measureReveal(browser, baseURL, MODES[mode]);
        samples.push({ ...load, ...reveal });
        console.log(`${mode} run ${run + 1}: ${JSON.stringify(samples[samples.length - 1])}`);
      }
      const medians = {};
      for (const key of Object.keys(samples[0])) medians[key] = round(median(samples.map((s) => s[key])));
      result.modes[mode] = { medians, samples };
    }
  } finally {
    result.meta.loadAverageEnd = os.loadavg().map(round);
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${args.out}`);
  for (const [mode, data] of Object.entries(result.modes)) console.log(mode, JSON.stringify(data.medians));
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
