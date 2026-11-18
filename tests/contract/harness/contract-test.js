// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Playwright fixture for the vendor contract suite.
 *
 * `harness.open()` gives a page that has loaded the REAL @pierre/diffs bundle
 * and the deterministic workload, with `window.H` (harness.js) ready. Requests
 * go to a virtual origin that this fixture fulfils from disk with
 * `context.route`, so no server runs and no port is bound.
 *
 * Console discipline is part of the contract. Every `console.error` and every
 * uncaught page error fails the test at teardown unless the spec declared it
 * with `harness.allowErrors(page, pattern)`. The development bundle's height
 * validator reports through `console.error`, so "validator 0" is the default
 * assertion of every spec, not something a spec has to remember.
 *
 * This file imports `@playwright/test` directly, never tests/e2e/fixtures.js:
 * the E2E worker-scoped test server must not start for a contract run.
 */

const { test: base, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { ORIGIN, CONTENT_TYPES, resolveVirtualPath } = require('./paths');

/** Messages the vendor's development-build height validator logs. */
const VALIDATOR_PATTERN = /does not match (DOM height|computed layout)/;

async function fulfilVirtualOrigin(route) {
  const url = new URL(route.request().url());
  const target = resolveVirtualPath(decodeURIComponent(url.pathname));
  if (target.file) {
    await route.fulfill({
      status: 200,
      contentType: CONTENT_TYPES[path.extname(target.file)] || 'application/octet-stream',
      body: fs.readFileSync(target.file),
    });
  } else if (typeof target.body === 'string') {
    await route.fulfill({ status: 200, contentType: target.contentType, body: target.body });
  } else {
    await route.fulfill({ status: target.status || 404, contentType: 'text/plain', body: 'not found' });
  }
}

/**
 * Keep a measurement a spec made. It is attached to the test result, and when
 * CONTRACT_EVIDENCE_DIR is set it is also written there as <name>.json. Gate
 * results quoted in plans/codeview-virtualized-diff.md come from these files.
 * Measurements are recorded, never asserted on: a timing is not a contract.
 */
async function recordMeasurement(testInfo, name, data) {
  const body = JSON.stringify(data, null, 2);
  await testInfo.attach(name, { body, contentType: 'application/json' });
  const dir = process.env.CONTRACT_EVIDENCE_DIR;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), body);
  }
}

const test = base.extend({
  harness: async ({ context }, use, testInfo) => {
    await context.route(`${ORIGIN}/**`, fulfilVirtualOrigin);
    const pages = [];

    const harness = {
      origin: ORIGIN,

      /**
       * Open a harness page.
       * @param {Object} [options]
       * @param {'dev'|'prod'} [options.bundle='dev'] - 'dev' is the development
       *   build (height validator compiled in); 'prod' is the exact file the
       *   app ships.
       * @param {string[]} [options.scripts] - extra script URL paths on the
       *   virtual origin, loaded in order after the workload (for example
       *   '/app/js/modules/pierre-context.js').
       * @param {string[]} [options.styles] - stylesheet URL paths, for example
       *   '/app/css/pr.css'.
       * @returns {Promise<import('@playwright/test').Page>}
       */
      async open({ bundle = 'dev', scripts = [], styles = [] } = {}) {
        const page = await context.newPage();
        const record = { page, errors: [], warnings: [], allowed: [] };
        pages.push(record);
        page.on('console', (message) => {
          const type = message.type();
          if (type === 'error') record.errors.push(message.text());
          else if (type === 'warning') record.warnings.push(message.text());
        });
        page.on('pageerror', (error) => record.errors.push(`pageerror: ${error.message}`));

        await page.goto(`${ORIGIN}/harness.html`);
        for (const href of styles) await page.addStyleTag({ url: `${ORIGIN}${href}` });
        await page.addScriptTag({ url: `${ORIGIN}/vendor/${bundle === 'prod' ? 'pierre-diffs.js' : 'pierre-diffs.dev.js'}` });
        // Vendor functions only this suite calls: window.VendorTestExtras (vendor-extras.js).
        await page.addScriptTag({ url: `${ORIGIN}/vendor/pierre-diffs-test-extras.js` });
        await page.addScriptTag({ url: `${ORIGIN}/workload.js` });
        for (const src of scripts) await page.addScriptTag({ url: `${ORIGIN}${src}` });
        await page.evaluate(() => window.H.loadWorkload());
        return page;
      },

      /** The workload's role → path map (see fixtures/workload.js). */
      roles(page) {
        return page.evaluate(() => window.H.workload.roles);
      },

      /**
       * Declare console errors a spec expects (a vendor bug it asserts on).
       * Anything not matched still fails the test at teardown.
       */
      allowErrors(page, ...patterns) {
        pages.find((r) => r.page === page).allowed.push(...patterns);
      },

      /** Every console.error / page error seen on the page so far. */
      errors(page) {
        return pages.find((r) => r.page === page).errors.slice();
      },

      /** Every console.warn seen on the page so far. */
      warnings(page) {
        return pages.find((r) => r.page === page).warnings.slice();
      },

      /** Keep a measurement (see recordMeasurement). */
      record(name, data) {
        return recordMeasurement(testInfo, name, data);
      },

      /** The subset of errors that came from the vendor's height validator. */
      validatorErrors(page) {
        return harness.errors(page).filter((text) => VALIDATOR_PATTERN.test(text));
      },
    };

    await use(harness);

    const unexpected = [];
    for (const record of pages) {
      for (const text of record.errors) {
        if (!record.allowed.some((pattern) => pattern.test(text))) unexpected.push(text.slice(0, 400));
      }
    }
    expect(unexpected, 'console errors the spec did not declare with harness.allowErrors').toEqual([]);
  },
});

module.exports = { test, expect, VALIDATOR_PATTERN };
