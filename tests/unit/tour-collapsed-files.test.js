// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Tour stops in collapsed files. A file is collapsed because it is viewed,
 * generated, or was collapsed by the reader; a tour that reaches a stop in
 * it opens the file, through the page's one writer of the collapsed state
 * (PRManager.setFileCollapsed), and closes it again when the tour ends.
 * Whether the stop's line is in the file's diff is asked of data
 * (PierreBridge.isLineInDiff), not of what is on screen: a collapsed file
 * shows no line, and a file that is scrolled away has no element.
 *
 * The page manager, its bridge and the renderer are production code; the
 * bridge is built by the page's own _createBridge over the recording
 * stand-in of the viewer (tests/utils/page-bridge.js). A file is collapsed
 * the way the page collapses it. No file has an element in the document.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { makePageWithBridge, restorePageBridges } = require('../utils/page-bridge.js');
const { TourRenderer } = require('../../public/js/modules/tour-renderer.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

const FILE = 'src/viewed.js';
const CONTEXT = 'lib/ctx.js';

/** A patch of FILE whose one hunk shows lines 1 to 20. */
function patch() {
  const body = ['@@ -1,20 +1,20 @@'];
  for (let n = 1; n <= 20; n++) body.push(n === 10 ? '+new 10' : ` line ${n}`);
  body.splice(10, 0, '-old 10');
  return [`diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`, ...body, ''].join('\n');
}

const contents = Array.from({ length: 100 }, (_, i) => `ctx ${i + 1}`).join('\n') + '\n';

let page;
let renderer;
beforeEach(async () => {
  page = makePageWithBridge(vendor, {
    files: [{ name: FILE, patch: patch() }],
    contextFiles: [{ name: CONTEXT, contents, endLine: 30 }],
    overrides: { _tourGen: 1 },
  });
  renderer = new TourRenderer(page.manager);
  // Marked Viewed, and a context file the reader collapsed.
  await page.manager.setFileCollapsed(FILE, true);
  await page.manager.setFileCollapsed(CONTEXT, true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  restorePageBridges();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const stop = (file, line, extra = {}) => ({ file_path: file, side: 'RIGHT', line_start: line, line_end: line, title: 'T', description: 'D', ...extra });
const tourStops = () => (file) => page.bridge.getAnnotations(file, 'tour-stop');

describe('a tour stop in a collapsed file', () => {
  it('is mounted on its line, and the file is opened through the page\'s writer', async () => {
    renderer.setStops([stop(FILE, 10)]);
    const row = await renderer.mountStop(0);

    expect(row).toBeTruthy();
    expect(tourStops()(FILE).map((a) => a.lineNumber)).toEqual([10]);
    expect(page.manager.isFileCollapsed(FILE)).toBe(false);
    expect(page.bridge.files.get(FILE).collapsed).toBe(false);
    expect(page.manager.collapsedFiles.has(FILE)).toBe(false);
    expect(renderer._autoExpanded.has(FILE)).toBe(true);
  });

  it('in a collapsed context file is mounted too (the context file is opened)', async () => {
    renderer.setStops([stop(CONTEXT, 12)]);
    expect(await renderer.mountStop(0)).toBeTruthy();
    expect(tourStops()(CONTEXT).map((a) => a.lineNumber)).toEqual([12]);
    expect(page.manager.isFileCollapsed(CONTEXT)).toBe(false);
    expect(page.bridge.files.get(CONTEXT).collapsed).toBe(false);
  });

  it('on exit, every file the tour opened is collapsed again, though none has an element', async () => {
    renderer.setStops([stop(FILE, 10), stop(CONTEXT, 12)]);
    await renderer.mountStop(0);
    await renderer.mountStop(1);
    expect(page.manager.isFileCollapsed(FILE)).toBe(false);
    expect(document.querySelector('.d2h-file-wrapper')).toBeNull();

    await renderer.unmountAll();

    expect(page.manager.isFileCollapsed(FILE)).toBe(true);
    expect(page.manager.isFileCollapsed(CONTEXT)).toBe(true);
    expect(page.bridge.files.get(FILE).collapsed).toBe(true);
    expect(page.bridge.files.get(CONTEXT).collapsed).toBe(true);
    expect(renderer._autoExpanded.size).toBe(0);
  });

  it('a file the reader closed again during the tour is left as the reader left it', async () => {
    renderer.setStops([stop(FILE, 10)]);
    await renderer.mountStop(0);
    await page.manager.setFileCollapsed(FILE, true);
    const writer = vi.spyOn(page.manager, 'setFileCollapsed');

    await renderer.unmountAll();
    expect(writer).not.toHaveBeenCalled();
    expect(page.manager.isFileCollapsed(FILE)).toBe(true);
  });

  it('whose lines are not in the diff is skipped, and the file stays collapsed', async () => {
    renderer.setStops([stop(FILE, 50, { line_end: 55 })]);
    expect(await renderer.mountStop(0)).toBeNull();
    expect(tourStops()(FILE)).toHaveLength(0);
    expect(page.manager.isFileCollapsed(FILE)).toBe(true);
    expect(renderer._autoExpanded.size).toBe(0);
  });

  it('a file that is not collapsed is not touched, and not re-collapsed on exit', async () => {
    await page.manager.setFileCollapsed(FILE, false);
    const writer = vi.spyOn(page.manager, 'setFileCollapsed');
    renderer.setStops([stop(FILE, 10)]);
    expect(await renderer.mountStop(0)).toBeTruthy();
    await renderer.unmountAll();
    expect(writer).not.toHaveBeenCalled();
    expect(page.manager.isFileCollapsed(FILE)).toBe(false);
  });
});
