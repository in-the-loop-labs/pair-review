// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * tests/e2e/diff-dom.js is the only E2E module that knows vendor DOM. It is
 * two files: diff-dom.js itself (the surface every spec imports) and
 * diff-dom-codeview.js, the part that reads the virtualized viewer's own
 * elements and records, which only diff-dom.js loads.
 *
 * The diff pane was moved from one @pierre/diffs renderer per file to a
 * single virtualized viewer (plans/codeview-virtualized-diff.md) without a
 * spec changing with it, because no spec names the vendor's elements,
 * attributes or instances: when the vendor's DOM changes, diff-dom.js
 * changes and the specs do not. The next vendor upgrade relies on the same.
 *
 * This is a grep test. It reads spec sources as text; comments count, because
 * a comment that names vendor DOM invites the next edit to use it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const E2E_DIR = path.resolve(__dirname, '../e2e');

/** Vendor DOM and vendor-instance names a spec may not contain. */
const FORBIDDEN = [
  { name: 'the vendor host element', pattern: /diffs-container/ },
  { name: 'a shadow root', pattern: /shadowRoot|assignedSlot/ },
  // `data-line-start`, `data-line-end` and `data-line-number` are the
  // application's own attributes on cards.
  { name: 'a vendor row attribute', pattern: /data-line(?![-\w])|data-line-(?:type|index)|data-alt-line/ },
  { name: 'a vendor gutter or content attribute', pattern: /data-column-number|data-(?:gutter|content|code)(?![-\w])/ },
  { name: 'a vendor separator or expand attribute', pattern: /data-separator|data-expand-/ },
  { name: 'a vendor column attribute', pattern: /data-additions|data-deletions|data-unified|data-diff-type/ },
  { name: 'the vendor annotation slot wrapper', pattern: /data-annotation-slot|data-line-annotation/ },
  { name: 'the bridge (ask diff-dom.js instead)', pattern: /pierreBridge/ },
  { name: 'the vendor bundle global', pattern: /PierreDiffs/ },
  // `inPage` and `waitInPage` hand a callback the page-side adapter of
  // diff-dom.js, whose records and elements are the viewer's own. A spec that
  // calls them holds the viewer's state by another name (it happened: a spec read
  // the bridge record's `baseMetadata` this way, and no pattern above saw it).
  // The scripts under tests/parity may use them; they are not specs.
  { name: 'the page-side adapter (add a named helper to diff-dom.js)', pattern: /\b(?:inPage|waitInPage)\b/ },
  { name: 'a field of the bridge\'s file record', pattern: /\bbaseMetadata\b|\bgetRenderedDiff\b|\bfileDiff\b/ },
];

/** The part of the module that reads the viewer's own DOM and records: loaded by diff-dom.js alone. */
const VIEWER_HALF = 'diff-dom-codeview.js';

/** Files allowed to contain them: the module's surface, and its viewer half. */
const ALLOWED_FILES = new Set(['diff-dom.js', VIEWER_HALF]);

/** Every .js file under tests/e2e, at any depth, as a path relative to it. */
function listSources(dir = E2E_DIR) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSources(full));
    else if (entry.name.endsWith('.js')) found.push(path.relative(E2E_DIR, full));
  }
  return found.sort();
}

function sources() {
  return listSources()
    .filter((name) => !ALLOWED_FILES.has(name))
    .map((name) => ({ name, text: fs.readFileSync(path.join(E2E_DIR, name), 'utf8') }));
}

describe('E2E vendor DOM boundary', () => {
  it('finds the E2E sources and the one file that may know vendor DOM', () => {
    const names = listSources();
    expect(names).toContain('diff-dom.js');
    expect(names).toContain(VIEWER_HALF);
    expect(sources().map((s) => s.name)).not.toContain(VIEWER_HALF);
    // One part per file: no second viewer half came back.
    expect(names.filter((name) => /^diff-dom-/.test(name))).toEqual([VIEWER_HALF]);
    // The corpus builders live one directory down and are scanned too.
    expect(names).toContain(path.join('fixtures', 'diffs.js'));
    expect(sources().map((s) => s.name)).not.toContain('diff-dom.js');
    expect(sources().filter((s) => s.name.endsWith('.spec.js')).length).toBeGreaterThan(40);
  });

  it('no spec, helper or fixture names vendor DOM or a vendor instance', () => {
    const violations = [];
    for (const { name, text } of sources()) {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(line)) {
            violations.push(`${name}:${index + 1}: ${rule.name}: ${line.trim().slice(0, 120)}`);
          }
        }
      });
    }
    expect(violations, `Move these behind tests/e2e/diff-dom.js:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the viewer half is loaded by diff-dom.js and by nothing else', () => {
    // A spec that imported it would hold the viewer's elements and records.
    const stem = VIEWER_HALF.replace(/\.js$/, '');
    const importers = listSources()
      .filter((name) => name !== VIEWER_HALF)
      .filter((name) => new RegExp(`['"\`]\\./${stem}(\\.js)?['"\`]`).test(fs.readFileSync(path.join(E2E_DIR, name), 'utf8')));
    expect(importers).toEqual(['diff-dom.js']);
    // It does know vendor DOM: the rule above is not vacuous for it.
    const viewerHalf = fs.readFileSync(path.join(E2E_DIR, VIEWER_HALF), 'utf8');
    expect(FORBIDDEN.filter((rule) => rule.pattern.test(viewerHalf)).length).toBeGreaterThan(3);
  });

  it('a spec gets the viewer half\'s helpers from diff-dom.js, in its one export list', () => {
    const surface = fs.readFileSync(path.join(E2E_DIR, 'diff-dom.js'), 'utf8');
    // The helpers the viewer half writes are spread into diff-dom.js's
    // exports, so a spec cannot tell which of the two files a helper is in.
    const exported = surface.slice(surface.indexOf('module.exports = {'));
    expect(exported).toContain('...viewerAdapter.overrides,');
    const text = fs.readFileSync(path.join(E2E_DIR, VIEWER_HALF), 'utf8');
    const block = text.slice(text.indexOf('    overrides: {'), text.indexOf('    expectations: {'));
    const overrides = [...block.matchAll(/^\s{6}(\w+),$/gm)].map((match) => match[1]);
    expect(overrides.length).toBeGreaterThan(8);
    expect(new Set(overrides).size).toBe(overrides.length);
  });

  it('the patterns do match what they are meant to (and spare the application attributes)', () => {
    const hit = (text) => FORBIDDEN.some((rule) => rule.pattern.test(text));
    expect(hit("page.locator('[data-line]')")).toBe(true);
    expect(hit('[data-line-type="context"]')).toBe(true);
    expect(hit('[data-column-number="4"]')).toBe(true);
    expect(hit('host.shadowRoot.querySelector')).toBe(true);
    expect(hit('window.prManager.pierreBridge.files')).toBe(true);
    expect(hit("row.getAttribute('data-line-start')")).toBe(false);
    expect(hit('tr[data-line-number="12"]')).toBe(false);
    expect(hit('.hunk-summary-row[data-content-hash="abc"]')).toBe(false);
    expect(hit("code.querySelector('[data-content]')")).toBe(true);
    expect(hit('.d2h-file-wrapper[data-file-name="src/utils.js"] .pierre-comment-btn')).toBe(false);
    expect(hit('inPage(page, (D, f) => !!D.record(f).baseMetadata, file)')).toBe(true);
    expect(hit('await waitInPage(page, (D) => D.upgradesIdle())')).toBe(true);
    expect(hit('instance.getRenderedDiff() === instance.fileDiff')).toBe(true);
    expect(hit('await firstFileBelowToolbar(page)')).toBe(false);
    expect(hit('await contentsApplied(page, FILE)')).toBe(false);
  });
});
