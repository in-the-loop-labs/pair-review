// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// The file-comments zone renders as a lineNumber:0 (file-level) body annotation
// through a registered custom renderer (see pr.js _ensurePierreFileCommentsRenderer),
// which returns pr.js's CACHED zone element. comment-minimizer keys file-level
// state on that element identity, so the renderer must return the SAME element
// across (re)renders, and the bridge must stamp data-pr-annotation-id so the
// slotted element is locatable. This pins that contract at the bridge layer.

describe('PierreBridge file-level annotation identity', () => {
  let env;
  let bridge;
  let root;

  beforeEach(() => {
    env = createPierreEnv({
      worker: false,
      parsePatch: (p) => ({
        name: 'f',
        hunks: [{ additionStart: 1, additionCount: 1, deletionStart: 1, deletionCount: 1 }],
        _p: p,
      }),
    });
    bridge = new env.PierreBridge({});
    root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('returns the renderer-supplied element and stamps data-pr-annotation-id', () => {
    const zone = env.document.createElement('div');
    zone.className = 'file-comments-zone';
    bridge.registerAnnotationRenderer('file-comments', () => zone);

    bridge.addAnnotation('a.js', {
      type: 'file-comments', side: 'RIGHT', lineNumber: 0,
      id: 'file-comments:a.js', data: { file: 'a.js' },
    });

    const stored = bridge.files.get('a.js').annotations
      .find(a => a.metadata.id === 'file-comments:a.js');
    expect(stored).toBeTruthy();
    expect(stored.lineNumber).toBe(0);

    const el = env.codeViews[0].renderAnnotationFor('a.js', stored);
    expect(el).toBe(zone);
    expect(el.dataset.prAnnotationId).toBe('file-comments:a.js');
  });

  it('serves the SAME element identity across repeated renders (remount-safe)', () => {
    let calls = 0;
    const zone = env.document.createElement('div');
    // Mirror pr.js: the renderer always returns the one cached zone element.
    bridge.registerAnnotationRenderer('file-comments', () => { calls++; return zone; });

    bridge.addAnnotation('a.js', {
      type: 'file-comments', side: 'RIGHT', lineNumber: 0,
      id: 'file-comments:a.js', data: { file: 'a.js' },
    });
    const stored = bridge.files.get('a.js').annotations
      .find(a => a.metadata.id === 'file-comments:a.js');

    const first = env.codeViews[0].renderAnnotationFor('a.js', stored);
    const second = env.codeViews[0].renderAnnotationFor('a.js', stored);
    expect(first).toBe(zone);
    expect(second).toBe(zone);
    expect(first).toBe(second); // identity preserved across remounts
    expect(calls).toBe(2);      // re-invoked each render (idempotent), not cached-away
  });

  it('sorts the file-comments annotation above line-anchored feedback', () => {
    bridge.registerAnnotationRenderer('file-comments', () => env.document.createElement('div'));
    // Inserted in REVERSE of the expected order (line 1 first, file-level last)
    // so insertion order alone cannot satisfy the assertion — only the
    // lineNumber sort in _sortedAnnotations can.
    bridge.addAnnotation('a.js', {
      type: 'comment', side: 'RIGHT', lineNumber: 1, id: 'comment-1',
      data: { id: 1, file: 'a.js', line_start: 1, body: 'x' },
    });
    bridge.addAnnotation('a.js', {
      type: 'file-comments', side: 'RIGHT', lineNumber: 0, id: 'file-comments:a.js', data: {},
    });
    // The published item lists the file-level zone first (lineNumber 0 sorts first).
    const item = env.codeViews[0].getItem('a.js');
    expect(item.annotations.map(a => a.metadata.id))
      .toEqual(['file-comments:a.js', 'comment-1']);
  });
});
