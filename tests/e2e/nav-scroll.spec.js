// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * E2E Tests: CodeView scroll stability + jump-to-file landing (Task #15).
 *
 * Regression coverage for a user-reported layout bug: CodeView estimated item
 * heights statically (20px/line, and the custom header was never measured), so
 * real vs estimated heights diverged and a wandering inter-item gap crept in as
 * you scrolled a multi-file diff — occluding file tails — and jump-to-file
 * landed the target header ~25px below the toolbar. core-impl fixed it by
 * syncing MEASURED item metrics back into CodeView (layout deltas → 0) and
 * adjusting the sticky offset on item scrolls (nav gap → ~1px).
 *
 * These lock that in: (1) after warming the measurement (one full scroll pass),
 * item tops are byte-stable across further scroll passes — no wander; (2)
 * jump-to-file lands the target's header flush under the sticky toolbar
 * (≤2px), including a virtualized-out target that mounts on scroll and a
 * collapsed target, in unified AND split, PR AND Local mode.
 */

import { test, expect } from './fixtures.js';
import { waitForDiffToRender, setDiffView } from './helpers.js';

const N_FILES = 6;
const LINES = 40;
const LANDING_TOLERANCE = 2; // px

/** A multi-file diff tall enough that later files virtualize out at load. */
function multiFileDiff() {
  let d = '';
  for (let f = 1; f <= N_FILES; f++) {
    d += `diff --git a/src/file${f}.js b/src/file${f}.js\n`;
    d += `--- a/src/file${f}.js\n+++ b/src/file${f}.js\n@@ -1,1 +1,${LINES} @@\n`;
    for (let i = 1; i <= LINES; i++) d += `+// file${f} line ${i}\n`;
  }
  return d;
}

function changedFiles() {
  const files = [];
  for (let f = 1; f <= N_FILES; f++) {
    files.push({ file: `src/file${f}.js`, additions: LINES, deletions: 0 });
  }
  return files;
}

// ── Row-less-leading-file fixture ───────────────────────────────────────────
// The item-metric probe measures a real rendered line row to replace the vendor's
// static estimate. A binary or mode-only file renders a header and NO line rows at
// all, so a probe that only ever samples the FIRST mounted host finds nothing to
// measure, burns its retry budget, and leaves lineHeight at the vendor default for
// every item in the view — the wandering-gap jank. These fixtures put two row-less
// files (binary, then mode-only) ahead of the normal ones.
// Names are chosen so the canonical path sort keeps them leading.
const ROWLESS_LEADING = ['assets/logo.png', 'src/mode-only.js'];
const ROWLESS_NORMAL = ['src/z1.js', 'src/z2.js', 'src/z3.js', 'src/z4.js'];

function rowLessLeadingDiff() {
  let d =
    'diff --git a/assets/logo.png b/assets/logo.png\n' +
    'index 1111111..2222222 100644\n' +
    'Binary files a/assets/logo.png and b/assets/logo.png differ\n' +
    'diff --git a/src/mode-only.js b/src/mode-only.js\n' +
    'old mode 100644\n' +
    'new mode 100755\n';
  for (const f of ROWLESS_NORMAL) {
    d += `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,${LINES} @@\n`;
    for (let i = 1; i <= LINES; i++) d += `+// ${f} line ${i}\n`;
  }
  return d;
}

function rowLessLeadingChangedFiles() {
  return [
    // `binary: true` is what makes pr.js build a real `type: 'binary'` CodeView
    // item (header only, zero hunks). Local mode has no binary flag — there its
    // patch simply parses to zero hunks, which is row-less all the same.
    { file: ROWLESS_LEADING[0], binary: true, additions: 0, deletions: 0 },
    { file: ROWLESS_LEADING[1], additions: 0, deletions: 0 },
    ...ROWLESS_NORMAL.map((f) => ({ file: f, additions: LINES, deletions: 0 })),
  ];
}

const MODES = [
  {
    name: 'PR mode',
    path: '/pr/test-owner/test-repo/1',
    async mockDiffText(page, diff, files) {
      await page.route('**/api/pr/*/*/*/diff', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ diff, changed_files: files }),
        })
      );
    },
    async mockDiff(page) {
      await this.mockDiffText(page, multiFileDiff(), changedFiles());
    },
  },
  {
    name: 'Local mode',
    path: '/local/2',
    async mockDiffText(page, diff, files) {
      // Trailing wildcard so it also matches the query-string form (?w=1, ?base=…)
      // that local.js appends — otherwise the request falls through to the real
      // (git-backed) route, which fails in the test env.
      await page.route('**/api/local/*/diff*', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            diff,
            stats: {
              files_changed: files.length,
              additions: files.reduce((n, f) => n + (f.additions || 0), 0),
              deletions: 0,
            },
          }),
        })
      );
    },
    async mockDiff(page) {
      await this.mockDiffText(page, multiFileDiff(), changedFiles());
    },
  },
];

/**
 * Drive one full scroll pass (top → bottom → top) so every item mounts + measures.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} [ids] - item ids whose tops must settle before returning
 */
async function fullScrollPass(page, ids = changedFiles().map((f) => f.file)) {
  await page.evaluate(async (ids) => {
    const root = document.getElementById('diff-container');
    // Small, uniform step so every item enters the render window and gets
    // measured (a large step can scroll past a file without mounting it).
    for (let y = 0; y <= root.scrollHeight; y += 150) {
      root.scrollTop = y;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 8)));
    }
    root.scrollTop = 0;
    // Wait for the layout to SETTLE rather than a fixed duration: the pass feeds
    // measured item metrics back into CodeView, which re-lays-out the content, so
    // the tops keep moving for an unpredictable number of frames afterwards.
    // Identical tops across consecutive frames IS that signal.
    const cv = window.prManager.pierreBridge.codeView;
    // Sample the scroll extent alongside the item tops: the measured-metric
    // resync arrives on its own rAF chain and relayouts the whole content, which
    // moves scrollHeight FIRST. Watching tops alone can see a few identical frames
    // in the pre-relayout state and declare victory, and the caller then measures
    // a layout that shifts underneath it (seen: 314px "drift" that was really an
    // early return).
    const sample = () => [root.scrollHeight, ...ids.map((id) => Math.round(cv.getTopForItem(id)))];
    let prev = sample();
    let stableFor = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 8)));
      const now = sample();
      const same = now.every((v, j) => v === prev[j]);
      prev = now;
      if (same) {
        if (++stableFor >= 6) return;
      } else {
        stableFor = 0;
      }
    }
    throw new Error(`item tops never settled after a full scroll pass (last: ${prev.join(',')})`);
  }, ids);
}

/**
 * getTopForItem for THIS spec's mocked changed files (absolute top in the scroll
 * content), addressed by their known ids rather than by enumerating
 * `bridge.files`: the per-worker review is shared with every other spec, so an
 * extra item (a context file, or a comment on a path outside this mocked diff)
 * can appear in that map and the layout assertions below would compare
 * mismatched lists.
 */
function itemTops(page, ids = changedFiles().map((f) => f.file)) {
  return page.evaluate((ids) => {
    const cv = window.prManager.pierreBridge.codeView;
    return ids.map((id) => Math.round(cv.getTopForItem(id)));
  }, ids);
}

/**
 * Jump to a file and return the gap (px) between its rendered header's top and
 * the sticky toolbar's bottom — i.e. how far below the toolbar the header
 * landed. ~0 is flush. Waits for the header to (re)mount for a virtualized-out
 * target.
 */
async function navLandingGap(page, fileName) {
  await page.evaluate((fn) => window.prManager.scrollToFile(fn), fileName);
  await page.waitForFunction((fn) => {
    const host = document.querySelector(`diffs-container[data-file-name="${fn}"]`);
    return !!(host && host.querySelector('.d2h-file-header'));
  }, fileName, { timeout: 10000 });
  // Poll until the SMOOTH scroll settles (gap unchanged over several frames)
  // rather than a fixed wait — smooth-scroll duration varies (longer in Local /
  // split), and a short wait reads the header mid-flight.
  return page.evaluate(async (fn) => {
    const measure = () => {
      const toolbar = document.querySelector('.diff-toolbar');
      const host = document.querySelector(`diffs-container[data-file-name="${fn}"]`);
      const header = host.querySelector('.d2h-file-header');
      return Math.round(header.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom);
    };
    let prev = measure();
    let stableFor = 0;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const g = measure();
      if (g === prev) {
        if (++stableFor >= 4) return g; // ~200ms unchanged = settled
      } else {
        stableFor = 0;
        prev = g;
      }
    }
    // Never return the last sample: it is mid-flight by definition, and a
    // mid-scroll value can sit inside the caller's 2px tolerance and green-light
    // a broken landing. A scroll that hasn't settled in 10s is a real failure.
    throw new Error(`nav scroll never settled for ${fn} (last gap ${prev}px)`);
  }, fileName);
}

for (const mode of MODES) {
  test.describe(`CodeView scroll stability + nav landing (${mode.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await mode.mockDiff(page);
      await page.goto(mode.path);
      await waitForDiffToRender(page);
    });

    test('item tops stay stable across scroll passes (no wandering gap)', async ({ page }) => {
      // Warm the measurement: full scroll passes mount + measure every item so
      // the one-time estimated→measured settle is behind us. It can take a
      // couple passes (the measured metrics re-sync), so warm up until two
      // consecutive passes agree — a GENUINE wandering gap would never converge
      // and this loop would fall through with a drifting `before`.
      let before = await itemTops(page);
      for (let i = 0; i < 5; i++) {
        await fullScrollPass(page);
        const t = await itemTops(page);
        const settled = t.every((v, j) => Math.abs(v - before[j]) <= LANDING_TOLERANCE);
        before = t;
        if (settled && i > 0) break;
      }
      // One more full pass must not move any item — measured layout is stable.
      await fullScrollPass(page);
      const after = await itemTops(page);

      // Every mocked file resolved to a real top (a missing item would otherwise
      // make the delta maths silently NaN-free nonsense). No length assertion:
      // itemTops maps over a fixed id list, so the length is true by construction.
      expect(after.every(Number.isFinite), `unresolved item tops: ${after.join(',')}`).toBe(true);
      const maxDelta = Math.max(...after.map((v, i) => Math.abs(v - before[i])));
      expect(maxDelta, `item tops drifted ${maxDelta}px across a scroll pass`).toBeLessThanOrEqual(LANDING_TOLERANCE);

      // And the files are laid out contiguously (uniform spacing for uniform
      // files) — a wandering gap would make later tops drift apart.
      const spacings = before.slice(1).map((v, i) => v - before[i]);
      const maxSpacingDelta = Math.max(...spacings.map((s) => Math.abs(s - spacings[0])));
      expect(maxSpacingDelta, 'inter-file spacing is not uniform (gap wanders)').toBeLessThanOrEqual(LANDING_TOLERANCE);
    });

    test('jump-to-file lands the header flush under the toolbar (mounted + virtualized-out)', async ({ page }) => {
      // A mid file that is mounted (or near) at load.
      expect(Math.abs(await navLandingGap(page, 'src/file2.js'))).toBeLessThanOrEqual(LANDING_TOLERANCE);

      // A late file that is virtualized OUT at load — must mount on scroll and
      // still land flush. (Local mode relies on the bridge's getStickyHeaderOffset
      // fallback now that scrollToFile passes undefined when the CSS var is unset.)
      await expect(
        page.locator('diffs-container[data-file-name="src/file6.js"]')
      ).toHaveCount(0); // confirm it started evicted
      expect(Math.abs(await navLandingGap(page, 'src/file6.js'))).toBeLessThanOrEqual(LANDING_TOLERANCE);
    });

    test('jump-to-file lands flush in split layout too', async ({ page }) => {
      await setDiffView(page, 'split');
      // Virtualized-out target in split — mounts on scroll and lands flush.
      expect(Math.abs(await navLandingGap(page, 'src/file5.js'))).toBeLessThanOrEqual(LANDING_TOLERANCE);
    });

    test('jump-to-file lands a collapsed target flush under the toolbar', async ({ page }) => {
      // A COLLAPSED (header-only) target is short, so the measure-and-correct
      // nav settle (`_awaitPierreNavGap`) engages to pin its header flush rather
      // than overshoot it under the sticky region.
      await navLandingGap(page, 'src/file3.js'); // bring it into view
      await page.locator('diffs-container[data-file-name="src/file3.js"] .file-collapse-toggle').click();
      await navLandingGap(page, 'src/file1.js'); // scroll away
      expect(Math.abs(await navLandingGap(page, 'src/file3.js'))).toBeLessThanOrEqual(LANDING_TOLERANCE);
    });

  });
}

// ────────────────────────────────────────────────────────────────────────────
// A row-less LEADING file (binary) must not leave item heights on the vendor's
// static defaults. The metric probe measures a real rendered line row; a binary
// item has none, so a probe that only sampled the first mounted host would burn
// its retry budget on a row-less shadow root and leave lineHeight at ~20 instead
// of the real ~17.4 for the whole view — which makes reserved and rendered
// heights disagree and the inter-item gap wander as you scroll.
//
// PR MODE ONLY, deliberately: a durably row-less item needs `binary: true` on the
// changed-file entry (that is what makes pr.js build a `type: 'binary'` item, and
// binary items are skipped by the content upgrade). Local mode derives its file
// list from the diff text and never sets that flag, so its header-only files get
// inlined by the idle content upgrade and grow real rows — there is no lasting
// row-less item to test there. The code under probe (`_syncCodeViewItemMetrics`)
// is shared by both modes.
// ────────────────────────────────────────────────────────────────────────────

test.describe('Item metrics with a row-less leading file (PR mode)', () => {
  test('a binary leading file does not leave item heights on vendor defaults', async ({ page }) => {
    await MODES[0].mockDiffText(page, rowLessLeadingDiff(), rowLessLeadingChangedFiles());
    await page.goto(MODES[0].path);
    await waitForDiffToRender(page);

    // Wait for the idle content upgrade to land on every non-binary file FIRST.
    // It inlines full file contents and re-renders those items taller, which moves
    // every later item — measuring before it lands reads a layout that is about to
    // shift (it looked exactly like a 314px "wandering gap" while writing this).
    await expect
      .poll(async () => page.evaluate((ids) => {
        const bridge = window.prManager.pierreBridge;
        return ids.filter((id) => !!bridge.files.get(id)?.baseMetadata).length;
      }, [ROWLESS_LEADING[1], ...ROWLESS_NORMAL]), { timeout: 20000 })
      .toBe(1 + ROWLESS_NORMAL.length);

    // Precondition: the leading binary item really renders no line rows at steady
    // state (otherwise this test would pass for the wrong reason).
    expect(
      await page.evaluate((fn) => {
        const host = document.querySelector(`diffs-container[data-file-name="${fn}"]`);
        return host && host.shadowRoot
          ? host.shadowRoot.querySelectorAll('[data-line]').length
          : null;
      }, ROWLESS_LEADING[0]),
      'the leading binary item should be header-only'
    ).toBe(0);

    // Warm the measurement the same way as the uniform-diff test.
    let before = await itemTops(page, ROWLESS_NORMAL);
    for (let i = 0; i < 5; i++) {
      await fullScrollPass(page, ROWLESS_NORMAL);
      const t = await itemTops(page, ROWLESS_NORMAL);
      const settled = t.every((v, j) => Math.abs(v - before[j]) <= LANDING_TOLERANCE);
      before = t;
      if (settled && i > 0) break;
    }

    // The probe looked PAST the row-less host and measured a real row: the metric
    // CodeView reserves space with is the height the DOM actually renders.
    const measured = await page.evaluate(() => {
      const bridge = window.prManager.pierreBridge;
      let rowHeight = null;
      for (const host of document.querySelectorAll('#diff-container diffs-container')) {
        const row = host.shadowRoot && host.shadowRoot.querySelector('[data-line-index]');
        if (row) {
          const h = row.getBoundingClientRect().height;
          if (h > 0) { rowHeight = h; break; }
        }
      }
      return { rowHeight, metricLineHeight: bridge._itemMetrics?.lineHeight ?? null };
    });
    expect(measured.rowHeight, 'no rendered line row to compare against').toBeGreaterThan(0);
    expect(
      measured.metricLineHeight,
      `lineHeight metric ${measured.metricLineHeight} does not match the rendered row height ${measured.rowHeight}`
    ).toBeCloseTo(measured.rowHeight, 0);

    // And the user-visible consequence: another pass moves nothing, and the
    // uniform files behind the binary one stay uniformly spaced.
    await fullScrollPass(page, ROWLESS_NORMAL);
    const after = await itemTops(page, ROWLESS_NORMAL);
    const maxDelta = Math.max(...after.map((v, i) => Math.abs(v - before[i])));
    expect(maxDelta, `item tops drifted ${maxDelta}px across a scroll pass`).toBeLessThanOrEqual(LANDING_TOLERANCE);

    const spacings = after.slice(1).map((v, i) => v - after[i]);
    const maxSpacingDelta = Math.max(...spacings.map((s) => Math.abs(s - spacings[0])));
    expect(maxSpacingDelta, 'inter-file spacing is not uniform (gap wanders)').toBeLessThanOrEqual(LANDING_TOLERANCE);
  });
});
