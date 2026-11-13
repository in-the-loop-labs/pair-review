// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Gate G8 (plans/codeview-virtualized-diff.md): does `pointerEventsOnScroll:
 * true` cost scroll smoothness?
 *
 * The option exists to stop hover work while content moves under a parked
 * pointer. The bridge needs `true` (fact F13: with the default, clicks on card
 * buttons are dropped after any scroll), so this gate measures the price: real
 * wheel input over the full workload with the pointer parked on the code, for
 * both values, in the bundle the app ships.
 *
 * Frame times are recorded, not asserted on. What is asserted is that both
 * runs complete with the list scrolled and no console error.
 */

import { test, expect } from '../harness/contract-test.js';

const WHEEL_STEPS = 240;
const WHEEL_DELTA = 120;

async function scrollRun(harness, pointerEventsOnScroll) {
  const page = await harness.open({ bundle: 'prod' });
  await page.evaluate(async (pointerEventsOnScroll) => {
    const H = window.H;
    await H.appLike({
      parse: { cacheKeyPrefix: 'contract:1' },
      build: { plain: 'end' },
      pool: true,
      options: { pointerEventsOnScroll, __devOnlyValidateItemHeights: false },
      maxMs: 20000,
    });
    window.__hoverEvents = 0;
  }, pointerEventsOnScroll);
  // Park the pointer over code so every scroll moves rows under it.
  await page.mouse.move(700, 450);
  await page.evaluate(() => { window.__stop = window.H.recordFrames(); window.__top0 = window.H.root.scrollTop; });
  for (let i = 0; i < WHEEL_STEPS; i++) {
    await page.mouse.wheel(0, WHEEL_DELTA);
  }
  return page.evaluate(async () => {
    const H = window.H;
    await H.raf(2);
    const frames = window.__stop();
    await H.settle();
    return { frames, scrolled: H.root.scrollTop - window.__top0, items: H.items.length, orphans: H.orphanHosts() };
  });
}

test('G8: scroll frame times with pointerEventsOnScroll false and true, pointer parked on the code', async ({ harness }) => {
  const off = await scrollRun(harness, false);
  const on = await scrollRun(harness, true);

  for (const run of [off, on]) {
    expect(run.items).toBe(61);
    expect(run.scrolled).toBeGreaterThan(WHEEL_STEPS * WHEEL_DELTA * 0.9);
    expect(run.orphans).toBe(0);
    expect(run.frames.n).toBeGreaterThan(0);
  }
  await harness.record('G8-pointer-events-on-scroll', {
    wheelSteps: WHEEL_STEPS,
    wheelDelta: WHEEL_DELTA,
    pointerEventsOnScrollFalse: off.frames,
    pointerEventsOnScrollTrue: on.frames,
  });
});
