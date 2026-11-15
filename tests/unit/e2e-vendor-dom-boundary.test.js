// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * tests/e2e/diff-dom.js is the only E2E module that knows vendor DOM. It has
 * three files while the application has two engines: diff-dom.js itself (the
 * surface every spec imports and what both engines share) and one half per
 * engine, diff-dom-filediff.js and diff-dom-codeview.js, which only
 * diff-dom.js loads.
 *
 * The diff engine is being moved from one @pierre/diffs FileDiff per file to a
 * single virtualized CodeView (plans/codeview-virtualized-diff.md). Parity is
 * proven by running the same specs against both engines, which only works if
 * no spec names the vendor's elements, attributes or instances: when the
 * engine changes, diff-dom.js changes and the specs do not.
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
  { name: 'the per-file body element of the FileDiff engine', pattern: /pierre-diff-body/ },
  { name: 'a shadow root', pattern: /shadowRoot|assignedSlot/ },
  // `data-line-start`, `data-line-end` and `data-line-number` are the
  // application's own attributes on cards and legacy rows.
  { name: 'a vendor row attribute', pattern: /data-line(?![-\w])|data-line-(?:type|index)|data-alt-line/ },
  { name: 'a vendor gutter or content attribute', pattern: /data-column-number|data-(?:gutter|content|code)(?![-\w])/ },
  { name: 'a vendor separator or expand attribute', pattern: /data-separator|data-expand-/ },
  { name: 'a vendor column attribute', pattern: /data-additions|data-deletions|data-unified|data-diff-type/ },
  { name: 'the vendor annotation slot wrapper', pattern: /data-annotation-slot|data-line-annotation/ },
  { name: 'the bridge (ask diff-dom.js instead)', pattern: /pierreBridge/ },
  { name: 'the vendor bundle global', pattern: /PierreDiffs/ },
  // `inPage` and `waitInPage` hand a callback the page-side adapter of
  // diff-dom.js, whose records and elements are the engine's own. A spec that
  // calls them holds engine state by another name (it happened: a spec read
  // the bridge record's `baseMetadata` this way, and no pattern above saw it).
  // The scripts under tests/parity may use them; they are not specs.
  { name: 'the page-side adapter (add a named helper to diff-dom.js)', pattern: /\b(?:inPage|waitInPage)\b/ },
  { name: 'a field of the bridge\'s file record', pattern: /\bbaseMetadata\b|\bgetRenderedDiff\b|\bfileDiff\b/ },
];

/** The module's engine halves: loaded by diff-dom.js alone. */
const ENGINE_HALVES = ['diff-dom-filediff.js', 'diff-dom-codeview.js'];

/** Files allowed to contain them: the module's surface, and its engine halves. */
const ALLOWED_FILES = new Set(['diff-dom.js', ...ENGINE_HALVES]);

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
    for (const half of ENGINE_HALVES) {
      expect(names).toContain(half);
      expect(sources().map((s) => s.name)).not.toContain(half);
    }
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

  it('the engine halves are loaded by diff-dom.js and by nothing else', () => {
    // A spec that imported one would know which engine it runs on.
    for (const half of ENGINE_HALVES) {
      const stem = half.replace(/\.js$/, '');
      const importers = listSources()
        .filter((name) => name !== half)
        .filter((name) => new RegExp(`['"\`]\\./${stem}(\\.js)?['"\`]`).test(fs.readFileSync(path.join(E2E_DIR, name), 'utf8')));
      expect(importers, half).toEqual(['diff-dom.js']);
    }
    // The virtualized viewer's half does know vendor DOM: the rule above is not vacuous for it.
    const codeview = fs.readFileSync(path.join(E2E_DIR, 'diff-dom-codeview.js'), 'utf8');
    expect(FORBIDDEN.filter((rule) => rule.pattern.test(codeview)).length).toBeGreaterThan(3);
  });

  it('a spec gets an engine\'s helpers under one name, whichever engine runs', () => {
    const surface = fs.readFileSync(path.join(E2E_DIR, 'diff-dom.js'), 'utf8');
    expect(surface).toContain('...engineAdapter.overrides,');
    const overridesOf = (half) => {
      const text = fs.readFileSync(path.join(E2E_DIR, half), 'utf8');
      const block = text.slice(text.indexOf('    overrides: {'), text.indexOf('    expectations: {'));
      return [...block.matchAll(/^\s{6}(\w+),$/gm)].map((match) => match[1]);
    };
    const filediff = overridesOf('diff-dom-filediff.js');
    const codeview = overridesOf('diff-dom-codeview.js');
    expect(filediff.length).toBeGreaterThan(8);
    // Everything the default engine's half gives, the virtualized viewer's half gives too:
    // a helper that existed on one engine only would be undefined on the other.
    expect(filediff.filter((name) => !codeview.includes(name))).toEqual([]);
    // What only the virtualized viewer's half gives replaces a helper diff-dom.js
    // has for both engines (`ensureMounted` is its own: a file need not be mounted).
    const exported = surface.slice(surface.indexOf('module.exports = {'));
    const unknown = codeview
      .filter((name) => !filediff.includes(name) && name !== 'ensureMounted')
      .filter((name) => !new RegExp(`^  ${name},$`, 'm').test(exported));
    expect(unknown).toEqual([]);
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
