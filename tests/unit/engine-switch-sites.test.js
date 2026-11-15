// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The diff engine switch (plans/codeview-virtualized-diff.md, phases 5 to 7).
 *
 * While the virtualized viewer is built behind
 * `window.__PAIR_REVIEW_DIFF_ENGINE === 'codeview'`, the application has two
 * engines. What keeps that from becoming a permanent double path is that the
 * switch is read once and branched on in a short, fixed list of places:
 * everything else decides from data and from the bridge's API, which both
 * bridges share. This is a grep test of that list. Phase 8 deletes the
 * switch; this test then asserts that it is gone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.resolve(__dirname, '../../public');

/** The methods of PRManager that may read `_diffEngine`, and why. */
const ALLOWED_SITES = {
  constructor: 'reads the global once and picks the bridge class',
  renderDiff: 'the two renderers',
  _removeRenderedFiles: 'the renderer\'s own teardown: wrappers are removed, the viewer is given an empty list',
  scrollToFile: 'a wrapper is scrolled to; an item is addressed by id',
  handleDiffViewChange: 'the viewer keeps the first visible line itself',
  _isDiffFileRendered: 'the upgrade enqueue trigger: a rendered body, or a mounted item',
  loadContextFiles: 'wrappers drawn by hand, or items synced from data',
  scrollToContextFile: 'a chunk of a wrapper, or an item',
  toggleContextFileCollapse: 'the wrapper\'s class, or setFileCollapsed',
  toggleContextFileViewed: 'the wrapper\'s class, or setFileCollapsed',
};

function listJs(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') found.push(...listJs(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.html')) {
      found.push(full);
    }
  }
  return found;
}

/** Every line of pr.js that names `_diffEngine`, with the method it is in. */
function engineReads() {
  const lines = fs.readFileSync(path.join(PUBLIC, 'js', 'pr.js'), 'utf8').split('\n');
  const reads = [];
  let method = null;
  lines.forEach((line, index) => {
    const declaration = /^  (?:async )?(?:static )?(?:get )?([A-Za-z_$][\w$]*)\(.*\) \{$/.exec(line);
    if (declaration) method = declaration[1];
    if (!/_diffEngine/.test(line)) return;
    // Prose about the switch is not a read of it.
    if (/^\s*(\/\/|\*)/.test(line)) return;
    reads.push({ method, line: index + 1, text: line.trim() });
  });
  return reads;
}

describe('the diff engine switch', () => {
  it('is read from the page once, in the PRManager constructor', () => {
    const hits = [];
    for (const file of listJs(PUBLIC)) {
      const text = fs.readFileSync(file, 'utf8');
      const count = (text.match(/__PAIR_REVIEW_DIFF_ENGINE/g) || []).length;
      if (count > 0) hits.push([path.relative(PUBLIC, file), count]);
    }
    expect(hits).toEqual([[path.join('js', 'pr.js'), 1]]);
    const assignment = engineReads().filter((read) => /this\._diffEngine\s*=[^=]/.test(read.text));
    expect(assignment.map((read) => read.method)).toEqual(['constructor']);
  });

  it('is branched on only in the listed methods of PRManager', () => {
    const reads = engineReads();
    expect(reads.length).toBeGreaterThan(0);
    const outside = reads.filter((read) => !Object.prototype.hasOwnProperty.call(ALLOWED_SITES, read.method));
    expect(outside, `_diffEngine is read outside the allowed sites:\n${outside.map((r) => `pr.js:${r.line} (${r.method}): ${r.text}`).join('\n')}`).toEqual([]);
    // Every listed site is still a site: a stale entry would let a new read hide behind it.
    const used = new Set(reads.map((read) => read.method));
    expect(Object.keys(ALLOWED_SITES).filter((name) => !used.has(name))).toEqual([]);
  });

  it('no other script of the pages knows the switch', () => {
    const others = listJs(PUBLIC)
      .filter((file) => path.relative(PUBLIC, file) !== path.join('js', 'pr.js'))
      .filter((file) => /_diffEngine/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(PUBLIC, file));
    expect(others).toEqual([]);
  });

  it('the layout class of the virtualized viewer is set where its bridge is made, and scopes every rule written for it', () => {
    const pr = fs.readFileSync(path.join(PUBLIC, 'js', 'pr.js'), 'utf8');
    expect(pr.match(/codeview-engine/g)).toHaveLength(1);
    const create = pr.slice(pr.indexOf('  _createCodeViewBridge(interaction) {'), pr.indexOf('  fileKind(filePath) {'));
    expect(create).toContain("classList.add('codeview-engine')");

    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'pr.css'), 'utf8');
    const start = css.indexOf('The virtualized diff viewer (diff engine \'codeview\')');
    expect(start).toBeGreaterThan(-1);
    // From the end of the block's heading comment; comments inside it removed.
    const block = css.slice(css.indexOf('*/', start) + 2).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(block.length).toBeGreaterThan(200);
    const selectors = block.split('}').map((rule) => rule.split('{')[0].trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThanOrEqual(6);
    const unscoped = selectors.filter((selector) => selector !== ':root' && !selector.includes('.diff-view.codeview-engine'));
    expect(unscoped).toEqual([]);
    // The one unscoped rule defines a token and changes nothing by itself.
    expect(block).toMatch(/:root \{[^}]*--pr-file-header-height: 53px;[^}]*\}/);
  });

  it('the numbers pr.css draws the virtualized pane with are the numbers the viewer is given', () => {
    // A pixel of height the viewer is not told about moves every file below
    // it. These pairs live in different files; this is where they meet.
    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'pr.css'), 'utf8');
    const block = css.slice(css.indexOf('The virtualized diff viewer (diff engine \'codeview\')')).replace(/\/\*[\s\S]*?\*\//g, '');
    const bridge = fs.readFileSync(path.join(PUBLIC, 'js', 'modules', 'pierre-codeview-bridge.js'), 'utf8');
    const rule = (selector) => {
      const at = block.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return block.slice(at, block.indexOf('}', at));
    };

    // The header: the token, and the bridge's fallback for a page without it.
    const token = Number(block.match(/--pr-file-header-height: (\d+)px;/)[1]);
    expect(bridge).toContain(`const FALLBACK_HEADER_HEIGHT = ${token};`);
    expect(rule('.diff-view.codeview-engine .pr-file-header-slot')).toContain('height: var(--pr-file-header-height);');

    // The scroll container has no box of its own; the pane's box is drawn
    // behind the list, 1 px of border and 16 px of padding around the files,
    // which is the layout padding above the first file ...
    const layout = bridge.match(/const DEFAULT_LAYOUT = \{ paddingTop: (\d+), paddingBottom: (\d+), gap: (\d+) \};/).slice(1).map(Number);
    const scroller = rule('.diff-view.codeview-engine > #diff-container');
    expect(scroller).toContain('border: 0;');
    expect(scroller).toContain(`padding: 0 ${layout[0]}px;`);
    const box = rule('.diff-view.codeview-engine > #diff-container::before');
    expect(box).toContain('border: 1px solid');
    expect(box).toContain(`margin: 0 -${layout[0]}px;`);
    expect(layout[0]).toBe(1 + 16);
    // ... and below the last, with the 24 px every file has under it on the
    // per-file renderer (its margin, which is the gap between two files).
    expect(layout[2]).toBe(24);
    expect(layout[1]).toBe(layout[0] + layout[2]);
    expect(css).toMatch(/\.d2h-file-wrapper\[data-file-name\] \{\s*margin-bottom: 24px;/);
    expect(rule('.diff-view.codeview-engine diffs-container.d2h-file-wrapper[data-file-name]')).toContain('margin-bottom: 0;');

    // What is under a header is keyed on the classes the bridge and
    // PRManager stamp on a file's element.
    expect(rule('.diff-view.codeview-engine diffs-container.has-diff-lines:not(.context-file) .file-comments-zone::after')).toContain('height: 8px;');
    expect(rule('.diff-view.codeview-engine diffs-container.has-diff-body:not(.has-diff-lines) .file-comments-zone::after')).toContain('height: 1px;');
    expect(bridge).toContain("classes.add('has-diff-lines')");
    expect(fs.readFileSync(path.join(PUBLIC, 'js', 'pr.js'), 'utf8')).toContain("classes.push('has-diff-body')");
  });

  it('nothing writes markup into the diff container', () => {
    const offenders = [];
    for (const file of listJs(path.join(PUBLIC, 'js'))) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/(diffContainer|diff-container'\))\.innerHTML\s*=/.test(line)) {
          offenders.push(`${path.relative(PUBLIC, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
