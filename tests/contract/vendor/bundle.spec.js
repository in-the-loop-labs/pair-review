// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The bundle itself: both flavours load in a real browser, carry the installed
 * version, and expose every name the entry script exports.
 *
 * Depends on it: everything. A name missing from window.PierreDiffs is not an
 * import error in an IIFE bundle; it is an `undefined` at the call site.
 */

import { test, expect } from '../harness/contract-test.js';
import { PATHS, readBundleStamp, installedVendorVersion } from '../harness/paths.js';
import { readEntryExports } from '../harness/entry-exports.js';

for (const bundle of ['prod', 'dev']) {
  test(`the ${bundle} bundle loads and exposes every entry export`, async ({ harness }) => {
    const page = await harness.open({ bundle });
    const defined = await page.evaluate(
      (names) => names.filter((name) => window.PierreDiffs[name] !== undefined),
      readEntryExports()
    );
    expect(defined).toEqual(readEntryExports());

    const kinds = await page.evaluate(() => ({
      CodeView: typeof window.PierreDiffs.CodeView,
      FileDiff: typeof window.PierreDiffs.FileDiff,
      WorkerPoolManager: typeof window.PierreDiffs.WorkerPoolManager,
      parsePatchFiles: typeof window.PierreDiffs.parsePatchFiles,
      getSingularPatch: typeof window.PierreDiffs.getSingularPatch,
      hydratePartialDiff: typeof window.PierreDiffs.hydratePartialDiff,
      parseDiffFromFile: typeof window.PierreDiffs.parseDiffFromFile,
    }));
    expect(kinds).toEqual({
      CodeView: 'function',
      FileDiff: 'function',
      WorkerPoolManager: 'function',
      parsePatchFiles: 'function',
      getSingularPatch: 'function',
      hydratePartialDiff: 'function',
      parseDiffFromFile: 'function',
    });
  });
}

test('both bundles are stamped with the installed vendor version', async () => {
  const installed = installedVendorVersion();
  expect(readBundleStamp(PATHS.prodBundle)).toEqual({ version: installed, mode: 'production' });
  expect(readBundleStamp(PATHS.devBundle)).toEqual({ version: installed, mode: 'development' });
});

test('the height validator exists only in the development bundle', async ({ harness }) => {
  // The validator is the arbiter of "the vendor's layout matches the DOM" for
  // the whole suite. This test proves it is live in the dev bundle (a header
  // metric that is deliberately wrong produces validator errors) and absent
  // from the bundle the app ships (the same set-up is silent).
  const run = async (bundle) => {
    const page = await harness.open({ bundle });
    harness.allowErrors(page, /does not match (DOM height|computed layout)/);
    await page.evaluate(async () => {
      const { roles } = window.H.workload;
      // Harness header is 40 px; the default metric is 44.
      await window.H.appLike({
        build: { only: [roles.small, roles.medium] },
        options: { itemMetrics: undefined },
      });
    });
    return harness.validatorErrors(page).length;
  };
  expect(await run('dev')).toBeGreaterThan(0);
  expect(await run('prod')).toBe(0);
});

test('the workload parses into the file kinds the suite relies on', async ({ harness }) => {
  const page = await harness.open();
  const summary = await page.evaluate(() => {
    const { roles } = window.H.workload;
    window.H.parse({});
    const byName = Object.fromEntries(window.H.fileDiffs.map((d) => [d.name, d]));
    const kind = (role) => {
      const d = byName[roles[role]];
      return d ? { type: d.type, hunks: d.hunks.length, isPartial: d.isPartial } : null;
    };
    return {
      files: window.H.fileDiffs.length,
      order: window.H.fileDiffs.map((d) => d.name).join('|') === window.H.workload.order.join('|'),
      noNewline: kind('noNewline'),
      large: kind('large'),
      hugeModified: kind('hugeModified'),
      hugeAdded: kind('hugeAdded'),
      added: kind('added'),
      emptyAdded: kind('emptyAdded'),
      deleted: kind('deleted'),
      renamePure: kind('renamePure'),
      renameChanged: kind('renameChanged'),
      binary: kind('binary'),
      modeOnly: kind('modeOnly'),
      prevNameOfRename: byName[roles.renamePure].prevName,
    };
  });
  expect(summary).toEqual({
    files: 59,
    order: true,
    noNewline: { type: 'change', hunks: 2, isPartial: true },
    large: { type: 'change', hunks: 3, isPartial: true },
    hugeModified: { type: 'change', hunks: 30, isPartial: true },
    hugeAdded: { type: 'new', hunks: 1, isPartial: true },
    added: { type: 'new', hunks: 1, isPartial: true },
    emptyAdded: { type: 'new', hunks: 0, isPartial: true },
    deleted: { type: 'deleted', hunks: 1, isPartial: true },
    renamePure: { type: 'rename-pure', hunks: 0, isPartial: true },
    renameChanged: { type: 'rename-changed', hunks: 1, isPartial: true },
    binary: { type: 'change', hunks: 0, isPartial: true },
    modeOnly: { type: 'change', hunks: 0, isPartial: true },
    prevNameOfRename: 'old-name/renamed.py',
  });
});
