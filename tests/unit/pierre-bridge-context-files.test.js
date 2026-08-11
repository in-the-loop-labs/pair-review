// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// Context files (whole-file reference views brought in by chat) become
// CodeViewFileItems appended after the diff items, keyed `context:<path>`.
//
// Regression coverage for issue #540: a context entry can share its path with a
// changed file already in the diff. Under CodeView the two are separate items
// with distinct ids (`<path>` for the diff, `context:<path>` for the context
// file), so collapse / remove / content updates on one must never touch the
// other. This encodes that independence at the bridge layer (the DOM-wrapper
// version of the guard is gone with the per-file cards).

const DIFF_ENTRY = {
  id: 'src/app.js',
  type: 'diff',
  fileName: 'src/app.js',
  patch: '@@ -1 +1 @@\n-old\n+new\n',
};

describe('PierreBridge context files', () => {
  let env;
  let bridge;
  let codeView;

  beforeEach(() => {
    env = createPierreEnv({ worker: false });
    bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [DIFF_ENTRY]);
    codeView = env.codeViews[0];
  });

  afterEach(() => {
    env.cleanup();
  });

  it('namespaces the context item id and reports it via hasContextFile', () => {
    expect(bridge.hasContextFile('src/app.js')).toBe(false);

    const added = bridge.addContextFile('src/app.js', 'FULL CONTENTS');

    expect(added).toBe(true);
    expect(bridge.hasContextFile('src/app.js')).toBe(true);
    // Both records coexist, keyed distinctly.
    expect(bridge.files.has('src/app.js')).toBe(true);
    expect(bridge.files.has('context:src/app.js')).toBe(true);
    // Appended after the diff item, as its own CodeView item.
    expect(codeView.itemIds()).toEqual(['src/app.js', 'context:src/app.js']);
  });

  it('builds a file (not diff) item carrying the whole-file contents', () => {
    bridge.addContextFile('src/app.js', 'FULL CONTENTS', { collapsed: true });

    const item = codeView.getItem('context:src/app.js');
    expect(item.type).toBe('file');
    expect(item.file).toMatchObject({ name: 'src/app.js', contents: 'FULL CONTENTS' });
    expect(item.collapsed).toBe(true);
    // The diff item is untouched by the context add.
    expect(codeView.getItem('src/app.js').type).toBe('diff');
  });

  it('is idempotent per path: a second add updates contents in place, no duplicate', () => {
    bridge.addContextFile('src/app.js', 'V1');
    const idsAfterFirst = codeView.itemIds();

    const result = bridge.addContextFile('src/app.js', 'V2');

    expect(result).toBe(true);
    expect(codeView.itemIds()).toEqual(idsAfterFirst); // no new item
    expect(codeView.getItem('context:src/app.js').file.contents).toBe('V2');
  });

  it('collapses the context entry without collapsing the same-path diff entry', () => {
    bridge.addContextFile('src/app.js', 'FULL CONTENTS');

    bridge.setContextFileCollapsed('src/app.js', true);

    expect(codeView.getItem('context:src/app.js').collapsed).toBe(true);
    // The diff entry for the same path stays expanded (#540).
    expect(codeView.getItem('src/app.js').collapsed).toBe(false);
    expect(bridge.files.get('src/app.js').collapsed).toBe(false);
  });

  it('removes only the context entry, leaving the same-path diff entry', () => {
    bridge.addContextFile('src/app.js', 'FULL CONTENTS');

    bridge.removeContextFileItem('src/app.js');

    expect(bridge.hasContextFile('src/app.js')).toBe(false);
    expect(bridge.files.has('context:src/app.js')).toBe(false);
    // The diff entry survives.
    expect(bridge.files.has('src/app.js')).toBe(true);
    expect(codeView.itemIds()).toEqual(['src/app.js']);
  });

  it('routes annotations to the context item without a diff side', () => {
    bridge.addContextFile('src/app.js', 'FULL CONTENTS');

    bridge.addAnnotation('context:src/app.js', {
      lineNumber: 3, type: 'comment', id: 'ctx-1', data: {},
    });

    const annotations = bridge.files.get('context:src/app.js').annotations;
    expect(annotations).toHaveLength(1);
    // File (context) items carry no side; diff items would.
    expect(annotations[0].side).toBeUndefined();
    expect(annotations[0].metadata.id).toBe('ctx-1');
  });

  it('returns false when the bridge has no CodeView yet', () => {
    const fresh = new env.PierreBridge({});
    expect(fresh.addContextFile('src/app.js', 'x')).toBe(false);
    expect(fresh.hasContextFile('src/app.js')).toBe(false);
  });
});
